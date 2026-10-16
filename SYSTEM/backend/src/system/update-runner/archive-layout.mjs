import crypto from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const BLOB_PATH = /^blobs\/sha256\/([a-f0-9]{64})$/u;
const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const CONFIG_TYPES = new Set(['application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json']);
// The existing exporter and diff_id verifier require uncompressed TAR layers.
const LAYER_TYPES = new Set(['application/vnd.oci.image.layer.v1.tar', 'application/vnd.docker.image.rootfs.diff.tar']);
const INDEX_TYPES = new Set([OCI_INDEX, 'application/vnd.docker.distribution.manifest.list.v2+json']);
const MANIFEST_TYPES = new Set([OCI_MANIFEST, 'application/vnd.docker.distribution.manifest.v2+json']);
const V1_KEYS = new Set(['id', 'parent', 'comment', 'created', 'container', 'container_config',
  'docker_version', 'author', 'config', 'architecture', 'variant', 'os', 'Size']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const regular = entry => entry && ['0', '\0'].includes(entry.type);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const digest = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const blobPath = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value)
  ? 'blobs/sha256/' + value.slice(7) : undefined;

function familiarTag(tag) {
  return tag.replace(/^(?:docker\.io|index\.docker\.io)\//u, '').replace(/^library\//u, '');
}

/** Validate both views of a modern Docker-save archive before signing it.
 * No archive member is extracted and no descriptor URL is fetched.
 * readJson returns bounded JSON bytes from an already indexed regular member.
 */
export async function validateDockerSaveOciLayout({parsed, imageConfig, outerEntries, readJson}) {
  const allowed = new Set(['oci-layout', 'index.json']);
  const tags = new Set(parsed.tags.map(familiarTag));
  const shortTags = new Set(parsed.tags.map(tag => tag.slice(tag.lastIndexOf(':') + 1)));
  const layout = (await readJson('oci-layout')).value;
  if (!object(layout) || layout.imageLayoutVersion !== '1.0.0') throw Error('RELEASE_ARCHIVE_OCI_LAYOUT_INVALID');
  const readBlob = async name => {
    if (!BLOB_PATH.test(name)) throw Error('RELEASE_ARCHIVE_OCI_BLOB_PATH_INVALID');
    const result = await readJson(name);
    if (digest(result.bytes) !== 'sha256:' + name.slice('blobs/sha256/'.length)) {
      throw Error('RELEASE_ARCHIVE_OCI_BLOB_DIGEST_MISMATCH');
    }
    return result;
  };
  const descriptor = (value, types, expectedPath) => {
    if (!object(value) || !types.has(value.mediaType) || !Number.isSafeInteger(value.size) || value.size <= 0
      || value.urls !== undefined || value.data !== undefined || value.artifactType !== undefined) {
      throw Error('RELEASE_ARCHIVE_OCI_DESCRIPTOR_INVALID');
    }
    const name = blobPath(value.digest), entry = outerEntries.get(name);
    if (!name || (expectedPath && name !== expectedPath) || !regular(entry) || entry.size !== value.size) {
      throw Error('RELEASE_ARCHIVE_OCI_DESCRIPTOR_MISMATCH');
    }
    if (value.platform !== undefined) {
      const platform = value.platform;
      if (!object(platform) || platform.os !== imageConfig.platform.os
        || platform.architecture !== imageConfig.platform.architecture
        || (platform.variant || '') !== (imageConfig.platform.variant || '')) {
        throw Error('RELEASE_ARCHIVE_OCI_PLATFORM_MISMATCH');
      }
    }
    if (value.annotations !== undefined) {
      if (!object(value.annotations) || Object.values(value.annotations).some(v => typeof v !== 'string')) {
        throw Error('RELEASE_ARCHIVE_OCI_ANNOTATIONS_INVALID');
      }
      const name = value.annotations['io.containerd.image.name'];
      const ref = value.annotations['org.opencontainers.image.ref.name'];
      if ((name !== undefined && !tags.has(familiarTag(name)))
        || (ref !== undefined && !shortTags.has(ref) && !tags.has(familiarTag(ref)))) {
        throw Error('RELEASE_ARCHIVE_OCI_TAG_MISMATCH');
      }
    }
    return name;
  };
  const visited = new Set();
  const walkIndex = async (index, depth = 0) => {
    if (!object(index) || index.schemaVersion !== 2 || (index.mediaType !== undefined && !INDEX_TYPES.has(index.mediaType))
      || !Array.isArray(index.manifests) || index.manifests.length !== 1 || depth > 4) {
      throw Error('RELEASE_ARCHIVE_OCI_SINGLE_IMAGE_REQUIRED');
    }
    const ref = index.manifests[0];
    const name = descriptor(ref, new Set([...INDEX_TYPES, ...MANIFEST_TYPES]));
    if (visited.has(name)) throw Error('RELEASE_ARCHIVE_OCI_INDEX_CYCLE');
    visited.add(name); allowed.add(name);
    const manifest = (await readBlob(name)).value;
    if (INDEX_TYPES.has(ref.mediaType)) return walkIndex(manifest, depth + 1);
    if (!object(manifest) || manifest.schemaVersion !== 2
      || (manifest.mediaType !== undefined && manifest.mediaType !== ref.mediaType)
      || manifest.subject !== undefined || manifest.artifactType !== undefined
      || !Array.isArray(manifest.layers) || manifest.layers.length !== parsed.layers.length) {
      throw Error('RELEASE_ARCHIVE_OCI_MANIFEST_INVALID');
    }
    descriptor(manifest.config, CONFIG_TYPES, parsed.configPath);
    for (let i = 0; i < manifest.layers.length; i++) {
      descriptor(manifest.layers[i], LAYER_TYPES, parsed.layers[i]);
    }
  };
  await walkIndex((await readJson('index.json')).value);

  // Moby also writes one content-addressed pre-1.9 V1 config per real layer.
  // These are metadata, not additional images; validate their schema and chain.
  const legacy = new Map();
  for (const entry of outerEntries.values()) {
    if (!regular(entry) || allowed.has(entry.name) || entry.name === parsed.configPath || parsed.layers.includes(entry.name)
      || !BLOB_PATH.test(entry.name)) continue;
    const value = (await readBlob(entry.name)).value;
    if (!object(value) || Object.keys(value).some(key => !V1_KEYS.has(key)) || !hex(value.id)
      || value.os !== 'linux' || (value.parent !== undefined && !hex(value.parent))
      || !(value.created === null || typeof value.created === 'string') || legacy.has(value.id)
      || legacy.size >= parsed.layers.length) throw Error('RELEASE_ARCHIVE_LEGACY_CONFIG_INVALID');
    legacy.set(value.id, value); allowed.add(entry.name);
  }
  if (legacy.size) {
    if (legacy.size !== parsed.layers.length) throw Error('RELEASE_ARCHIVE_LEGACY_CONFIG_CHAIN_INVALID');
    const parents = new Set([...legacy.values()].map(value => value.parent).filter(Boolean));
    const tips = [...legacy.values()].filter(value => !parents.has(value.id));
    if (tips.length !== 1) throw Error('RELEASE_ARCHIVE_LEGACY_CONFIG_CHAIN_INVALID');
    const top = tips[0], seen = new Set();
    let current = top;
    while (current) {
      if (seen.has(current.id)) throw Error('RELEASE_ARCHIVE_LEGACY_CONFIG_CHAIN_INVALID');
      seen.add(current.id);
      if (!current.parent) break;
      current = legacy.get(current.parent);
      if (!current) throw Error('RELEASE_ARCHIVE_LEGACY_CONFIG_CHAIN_INVALID');
    }
    if (seen.size !== legacy.size || !isDeepStrictEqual(top.config?.Labels || {}, imageConfig.labels)
      || top.architecture !== imageConfig.platform.architecture
      || (top.variant || '') !== (imageConfig.platform.variant || '')) {
      throw Error('RELEASE_ARCHIVE_LEGACY_CONFIG_IDENTITY_MISMATCH');
    }
  }
  if (outerEntries.has('repositories')) {
    const repositories = (await readJson('repositories')).value, found = new Set();
    if (!object(repositories)) throw Error('RELEASE_ARCHIVE_REPOSITORIES_INVALID');
    for (const [repository, versions] of Object.entries(repositories)) {
      if (!object(versions)) throw Error('RELEASE_ARCHIVE_REPOSITORIES_INVALID');
      for (const [tag, layer] of Object.entries(versions)) {
        const name = familiarTag(repository + ':' + tag);
        if (!tags.has(name) || found.has(name) || layer !== parsed.layers.at(-1).slice('blobs/sha256/'.length)) {
          throw Error('RELEASE_ARCHIVE_REPOSITORIES_INVALID');
        }
        found.add(name);
      }
    }
    if (found.size !== tags.size) throw Error('RELEASE_ARCHIVE_REPOSITORIES_INVALID');
  }
  return allowed;
}
