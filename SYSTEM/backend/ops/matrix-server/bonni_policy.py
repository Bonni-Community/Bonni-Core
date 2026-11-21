"""Synapse module. Access tokens, account passwords and private keys are never stored."""
import re
from synapse.module_api import NOT_SPAM
from synapse.module_api.errors import ConfigError, SynapseError, Codes
from synapse.http.server import DirectServeJsonResource


def server_name(value):
    if not isinstance(value, str) or len(value) > 255 or not re.fullmatch(
        r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::[1-9][0-9]{0,4})?", value
    ):
        raise ConfigError("Bonni: use exact DNS server names, without scheme, path, wildcard or IP literal")
    host, _, port = value.partition(":")
    if any(not part or len(part) > 63 or part.startswith("-") or part.endswith("-") for part in host.split(".")):
        raise ConfigError("Bonni: invalid server name")
    if port and int(port) > 65535:
        raise ConfigError("Bonni: invalid server port")
    if re.fullmatch(r"[0-9.]+", host):
        raise ConfigError("Bonni: use DNS server names instead of IP literals")
    return value.lower()


def user_server(user_id):
    if not isinstance(user_id, str) or not user_id.startswith("@") or ":" not in user_id:
        return None
    return user_id.split(":", 1)[1].lower()


class PolicyResource(DirectServeJsonResource):
    def __init__(self, module):
        super().__init__()
        self.module = module

    async def _async_render_GET(self, request):
        await self.module.local_requester(request)
        return 200, {
            "version": 1, "serverName": self.module.server,
            "enforced": True, "localDirectoryOnly": True,
            "allowedServers": sorted(self.module.allowed - {self.module.server}),
        }


class MembersResource(DirectServeJsonResource):
    def __init__(self, module):
        super().__init__()
        self.module = module

    async def _async_render_GET(self, request):
        requester = await self.module.local_requester(request)
        try:
            term = request.args.get(b"search", [b""])[0].decode("utf-8").strip()
            after = request.args.get(b"after", [b""])[0].decode("utf-8")
            limit = int(request.args.get(b"limit", [b"100"])[0])
        except (UnicodeError, ValueError):
            raise SynapseError(400, "Invalid directory request")
        if len(term) > 200 or len(after) > 255 or not 1 <= limit <= 100:
            raise SynapseError(400, "Invalid directory request")

        def select(txn):
            # Public module DB API; fixed, parameterized read of the local users
            # table only. Profiles are obtained using the public profile API.
            txn.execute("SELECT name FROM users WHERE deactivated = 0 AND is_guest = 0 "
                        "AND appservice_id IS NULL AND (user_type IS NULL OR user_type <> 'support') "
                        "AND name > ? ORDER BY name LIMIT ?", (after, limit + 1))
            return [row[0] for row in txn.fetchall()]
        ids = await self.module.api.run_db_interaction("bonni_local_members", select)
        members = []
        for user_id in ids[:limit]:
            if user_server(user_id) != self.module.server or user_id == requester:
                continue
            profile = await self.module.api.get_profile_for_user(user_id[1:].split(":", 1)[0])
            name = profile.display_name or user_id
            if term and term.casefold() not in name.casefold() and term.casefold() not in user_id.casefold():
                continue
            members.append({"user_id": user_id, "display_name": profile.display_name})
        return 200, {"results": members, "next": ids[limit - 1] if len(ids) > limit else None}


class BonniPolicy:
    @staticmethod
    def parse_config(config):
        if not isinstance(config, dict) or not isinstance(config.get("allowed_servers", []), list):
            raise ConfigError("Bonni: allowed_servers must be an explicit list")
        return {"server_name": server_name(config.get("server_name")),
                "allowed_servers": [server_name(name) for name in config.get("allowed_servers", [])]}

    def __init__(self, config, api):
        self.api = api
        self.server = config["server_name"]
        if api.server_name.lower() != self.server:
            raise ConfigError("Bonni: module server name differs from Synapse server_name")
        self.allowed = frozenset([self.server, *config["allowed_servers"]])
        api.register_spam_checker_callbacks(
            check_username_for_spam=self.check_directory,
            should_drop_federated_event=self.drop_event,
            user_may_invite=self.may_invite,
            federated_user_may_invite=self.federated_invite,
        )
        api.register_web_resource("/_synapse/client/bonni/policy", PolicyResource(self))
        api.register_web_resource("/_synapse/client/bonni/members", MembersResource(self))

    async def local_requester(self, request):
        requester = await self.api.get_user_by_req(request, allow_guest=False)
        user_id = requester.user.to_string()
        if user_server(user_id) != self.server:
            raise SynapseError(403, "Only local authenticated members may use this directory")
        return user_id

    async def check_directory(self, profile, requester_id=None):
        return (requester_id is not None and user_server(requester_id) != self.server) or user_server(profile.get("user_id")) != self.server

    async def may_invite(self, inviter, invitee, room_id):
        if user_server(inviter) not in self.allowed or user_server(invitee) not in self.allowed:
            return Codes.FORBIDDEN
        return NOT_SPAM

    async def federated_invite(self, event):
        return await self.may_invite(event.sender, event.state_key, event.room_id)

    async def drop_event(self, event):
        if user_server(event.sender) not in self.allowed:
            return True
        if event.type == "m.room.member" and event.content.get("membership") in ("join", "invite"):
            return user_server(event.state_key) not in self.allowed
        return False
