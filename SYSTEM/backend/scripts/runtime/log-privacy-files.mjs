import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {privateText} from './log-privacy.mjs';

export const LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export function assertPrivateLogPath(file) {
 const resolved = path.resolve(file); let current = path.parse(resolved).root;
 for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
  current = path.join(current, part);
  try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('CORE_LOG_ROOT_SYMLINK_FORBIDDEN'); }
  catch(error) { if(error.code === 'ENOENT') break; throw error; }
 }
}
// Rewrite only a caller-selected diagnostic file. The temporary contains
// already projected technical data; there is deliberately no raw backup.
export function cleanPrivateLogFile(file, {now = Date.now(), maxAgeMs = LOG_MAX_AGE_MS} = {}) {
 assertPrivateLogPath(file);
 let fd, temp, out;
 try {
  fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const state = fs.fstatSync(fd);
  if (!state.isFile() || state.nlink !== 1) throw new Error('CORE_LOG_FILE_UNSAFE');
  const unchanged = () => { const s = fs.lstatSync(file); if(s.dev !== state.dev || s.ino !== state.ino || s.size !== state.size || s.mtimeMs !== state.mtimeMs) throw new Error('CORE_LOG_FILE_CHANGED'); };
  if(now - state.mtimeMs > maxAgeMs) { unchanged(); fs.closeSync(fd); fd = undefined; fs.unlinkSync(file); return 'expired'; }
  // Old oversized protocols are discarded rather than read or copied raw.
  if(state.size > 8*1024*1024) { unchanged(); fs.closeSync(fd); fd=undefined; fs.unlinkSync(file); return 'oversize'; }
  const raw = fs.readFileSync(fd, 'utf8');
  const safe = privateText(raw);
  if(safe === raw) { if(process.platform !== 'win32') fs.fchmodSync(fd,0o600); return 'unchanged'; }
  temp = path.join(path.dirname(file), '.bonni-private-' + randomUUID() + '.tmp');
  out = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  fs.writeFileSync(out, safe, 'utf8'); fs.fsyncSync(out); fs.closeSync(out); out=undefined;
  unchanged(); fs.closeSync(fd); fd=undefined;
  fs.renameSync(temp,file); temp=undefined;
  fs.utimesSync(file, state.atime, state.mtime);
  return 'cleaned';
 } catch(error) { if(error.code === 'ENOENT') return 'absent'; throw error; }
 finally { if(fd !== undefined) fs.closeSync(fd); if(out !== undefined) fs.closeSync(out); if(temp) {try{fs.unlinkSync(temp);}catch{}} }
}

export function cleanKnownDiagnosticTree(productRoot) {
 const root = path.resolve(productRoot); assertPrivateLogPath(root);
 let count = 0, visited = 0;
 function walk(directory, depth, labor = false) {
  if(depth > 9 || ++visited > 5000) throw new Error('CORE_LOG_CLEANUP_LIMIT');
  assertPrivateLogPath(directory);
  let entries; try { entries = fs.readdirSync(directory, {withFileTypes:true}); } catch(error) {if(error.code === 'ENOENT') return; throw error;}
  for(const entry of entries) {
   const file = path.join(directory, entry.name);
   if(entry.isSymbolicLink()) throw new Error('CORE_LOG_ROOT_SYMLINK_FORBIDDEN');
   if(entry.isDirectory()) {
    // Source, business data and backup trees are outside diagnostic scope.
    if(['program','program-slots','node_modules','STORAGE','storage','BACKUP','backup','ARCHIV','archiv','SYSTEM'].includes(entry.name)) continue;
    walk(file, depth + 1, labor);
   } else if(entry.isFile() && ((labor && entry.name === 'terminal.log') || (path.basename(directory) === 'CORE' && path.basename(path.dirname(directory)) === 'LOGS' && /^bonni-core(?:-error\.txt|\.log)(?:\.[12])?$/.test(entry.name)))) {
    cleanPrivateLogFile(file); count++;
   }
  }
 }
 for(const name of ['SYSTEM','system']) { cleanPrivateLogFile(path.join(root,'RUN_SYSTEM',name,'emergency','emergency.log')); }
 for(const run of ['RUN_SYSTEM','RUN_DEV','RUN_INSTALL']) {
  walk(path.join(root,run,'LOGS','CORE'),0);
  walk(path.join(root,run,'development-tests'),0,true);
 }
 return {checkedFiles:count};
}
