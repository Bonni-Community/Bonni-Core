// CI only: simulate a process crash, not an operator's Docker stop/kill.
// Docker kill marks a container manually stopped and suppresses restart policy.
import {describeCrashProcess,readCrashProcessDiagnostic} from './smoke-process-diagnostics.mjs';
export function inspectCrashTarget({pid,fsImpl,pathImpl,
  controllerPath='/app/backend/scripts/deployment/controller.mjs'}) {
  if(!Number.isSafeInteger(pid)||pid<=1)throw Error('SMOKE_CRASH_PID_INVALID');
  const proc='/proc/'+pid;
  const argv=fsImpl.readFileSync(proc+'/cmdline','utf8').split('\0').filter(Boolean);
  // With pid:host Docker does not insert tini, even when init:true is set.
  // entrypoint.sh execs this Node controller. QEMU may prefix its argv.
  // DEV.44 also recorded the exact ARM64 form with preserved original argv[0].
  // Only that four-argument shape is added; no arbitrary QEMU options are allowed.
  const emulated=argv.length===3
    &&/^qemu-(arm|aarch64)(-static)?$/.test(pathImpl.basename(argv[0]));
  const preservedArm64=argv.length===4
    &&pathImpl.basename(argv[0])==='qemu-aarch64'
    &&argv[1]==='/usr/local/bin/node'&&argv[2]==='node';
  const command=preservedArm64?[argv[1],argv[3]]:emulated?argv.slice(1):argv;
  if(command.length!==2||pathImpl.basename(command[0]||'')!=='node'
    ||command[1]!==controllerPath) {
    const error=Error('SMOKE_CRASH_PROCESS_MISMATCH');
    error.processDiagnostic=describeCrashProcess(argv,controllerPath,pathImpl);
    throw error;
  }
  if(fsImpl.readlinkSync(proc+'/ns/mnt')!==fsImpl.readlinkSync('/proc/self/ns/mnt')
    ||fsImpl.readFileSync(proc+'/cgroup','utf8')!==fsImpl.readFileSync('/proc/self/cgroup','utf8'))
    throw Error('SMOKE_CRASH_CONTAINER_MISMATCH');
  const stat=fsImpl.readFileSync(proc+'/stat','utf8');
  const startTicks=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/)[19];
  if(!/^\d+$/.test(startTicks||''))throw Error('SMOKE_CRASH_START_TIME_INVALID');
  return {pid,startTicks};
}

export const crashControllerScript = `
const fs=require('node:fs'),path=require('node:path');
const describeCrashProcess=${describeCrashProcess.toString()};
const inspectCrashTarget=${inspectCrashTarget.toString()};
try {
  const target=inspectCrashTarget({pid:Number(process.argv[1]),fsImpl:fs,pathImpl:path});
  if(process.argv[2]==='validate')process.stdout.write(JSON.stringify(target));
  else if(process.argv[2]==='kill') {
    if(target.startTicks!==process.argv[3])throw Error('SMOKE_CRASH_PID_REUSED');
    process.kill(target.pid,'SIGKILL');
  } else throw Error('SMOKE_CRASH_ACTION_INVALID');
} catch(error) {
  if(error.message==='SMOKE_CRASH_PROCESS_MISMATCH'&&error.processDiagnostic)
    process.stdout.write(JSON.stringify(error.processDiagnostic));
  process.stderr.write(/^SMOKE_CRASH_[A-Z_]+$/.test(error.message)
    ?error.message:'SMOKE_CRASH_INJECTION_ERROR');
  process.exitCode=42;
}
`;

export async function testControllerRecovery({docker,id,project,root,delay,
  attempts=240,interval=5000,crashObservationAttempts=6,log=console.log}) {
  if(!/^bonni-ci-\d+-\d+-(amd64|arm64|armv7)$/.test(project)
    ||root!=='/tmp/bonni-deployment-ci-'+project.slice('bonni-ci-'.length)
    ||!/^[a-f0-9]{64}$/.test(id))throw Error('SMOKE_RECOVERY_SCOPE_INVALID');
  const inspect=()=>{
    const rows=JSON.parse(docker(['inspect',id]));
    if(rows.length!==1||rows[0].Id!==id)throw Error('SMOKE_RECOVERY_ID_CHANGED');
    return rows[0];
  };
  const before=inspect(),labels=before.Config?.Labels;
  if(labels?.['com.docker.compose.project']!==project
    ||labels?.['com.docker.compose.service']!=='bonni-core'
    ||before.HostConfig?.PidMode!=='host'||before.HostConfig?.Init!==true
    ||before.HostConfig?.RestartPolicy?.Name!=='unless-stopped'
    ||!before.Mounts?.some(m=>m.Type==='bind'&&m.Source===root&&m.Destination===root)
    ||!before.State?.Running||before.State.Health?.Status!=='healthy'
    ||!Number.isSafeInteger(before.State.Pid)||before.State.Pid<=1
    ||!before.State.StartedAt||!Number.isSafeInteger(before.RestartCount))
    throw Error('SMOKE_RECOVERY_TARGET_INVALID');
  const execArgs=action=>['exec',id,'node','-e',crashControllerScript,String(before.State.Pid),action];
  const safeReason=error=>{
    const value=String(error?.stderr||'').trim();
    return /^SMOKE_CRASH_[A-Z_]+$/.test(value)?value:'SMOKE_CRASH_EXEC_FAILED';
  };
  const logProcessDiagnostic=error=>{
    if(safeReason(error)!=='SMOKE_CRASH_PROCESS_MISMATCH')return;
    const diagnostic=readCrashProcessDiagnostic(error?.stdout);
    if(diagnostic) {
      log('Controller-Prozessdiagnose: '+JSON.stringify(diagnostic));
      log('Controller-Soll: node + controller-exact; optional QEMU-Präfix. Zusätzlich exakt qemu-aarch64 + /usr/local/bin/node + node + controller-exact. Unbekannte Argumente sind maskiert.');
    }
  };
  let target;
  try {
    target=JSON.parse(docker(execArgs('validate')));
    if(target.pid!==before.State.Pid||typeof target.startTicks!=='string'
      ||!/^\d+$/.test(target.startTicks))throw Error();
  } catch(error) {
    logProcessDiagnostic(error);
    throw Error('SMOKE_CONTROLLER_CRASH_PREFLIGHT_FAILED: '+safeReason(error));
  }
  // Attached exec makes rejected targets visible. The kill exec may lose its
  // connection with the container; only Docker state can prove a real restart.
  log('Controller-Absturztest: gezielter Prozessabbruch; Docker-Neustartautomatik bleibt aktiv.');
  log('Controller-Absturzziel geprüft: Host-PID '+target.pid+'.');
  try {docker([...execArgs('kill'),target.startTicks]);}
  catch(error) {
    logProcessDiagnostic(error);
    if(error.status===42)throw Error('SMOKE_CONTROLLER_CRASH_INJECTION_FAILED: '+safeReason(error));
    log('Abbruchaufruf beendet; tatsächlicher Prozessabbruch wird am Containerzustand geprüft.');
  }
  const diagnostic=current=>JSON.stringify({
    status:current.State.Status,running:current.State.Running,
    health:current.State.Health?.Status,exitCode:current.State.ExitCode,
    restartCount:current.RestartCount,restarted:current.State.StartedAt!==before.State.StartedAt
  });
  let current=before,crashObserved=false;
  for(let attempt=0;attempt<attempts;attempt++) {
    await delay(interval);
    current=inspect();
    crashObserved ||= !current.State.Running||current.State.Pid!==before.State.Pid
      ||current.State.StartedAt!==before.State.StartedAt||current.RestartCount>before.RestartCount;
    if(current.RestartCount>before.RestartCount
      &&current.State.StartedAt!==before.State.StartedAt
      &&current.State.Running&&current.State.Health?.Status==='healthy') {
      log('Controller nach Prozessabbruch automatisch neu gestartet und gesund.');
      return;
    }
    if(!crashObserved&&attempt+1>=crashObservationAttempts) {
      log('Kein Controller-Prozessabbruch beobachtet: '+diagnostic(current));
      throw Error('SMOKE_CONTROLLER_CRASH_NOT_OBSERVED');
    }
  }
  // Whitelist diagnostics: never dump Config.Env, mounts or health output.
  log('Controller-Wiederherstellung nicht bestätigt: '+diagnostic(current));
  throw Error('SMOKE_CONTROLLER_RECOVERY_FAILED');
}
