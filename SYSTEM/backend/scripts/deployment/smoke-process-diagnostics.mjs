// Diagnostic labels only. Never emit arbitrary argv values, paths or environment.
// This describes rejected targets; it grants no permission to signal a process.
export function describeCrashProcess(argv, controllerPath, pathImpl) {
  const classify=value=>{
    if(value===controllerPath)return 'controller-exact';
    if(value==='scripts/deployment/controller.mjs'||value==='./scripts/deployment/controller.mjs')return 'controller-relative';
    if(['/usr/local/bin/node','/usr/bin/node','node'].includes(value))return value;
    if(value==='/dev/.buildkit_qemu_emulator')return 'buildkit-qemu';
    const base=pathImpl.basename(value);
    if(/^qemu-(arm|aarch64)(-static)?$/.test(base))return base;
    if(base==='node')return 'node-other-path';
    if(base==='controller.mjs')return 'controller-other-path';
    if(['tini','docker-init','sh','bash'].includes(base))return base;
    if(['-0','-L','--argv0','--'].includes(value))return value;
    return 'redacted';
  };
  return {schema:'bonni.crash-process-diagnostic/v1',argc:argv.length,
    argv:argv.slice(0,12).map(classify),truncated:argv.length>12};
}

// Validate again at the log boundary: docker/exec output is not trusted text.
export function readCrashProcessDiagnostic(raw) {
  const text=String(raw||'').trim();
  if(!text||text.length>1024)return null;
  try {
    const value=JSON.parse(text);
    const allowed=new Set(['controller-exact','controller-relative','/usr/local/bin/node',
      '/usr/bin/node','node','buildkit-qemu','qemu-arm','qemu-arm-static',
      'qemu-aarch64','qemu-aarch64-static','node-other-path','controller-other-path',
      'tini','docker-init','sh','bash','-0','-L','--argv0','--','redacted']);
    if(value?.schema!=='bonni.crash-process-diagnostic/v1'
      ||!Number.isSafeInteger(value.argc)||value.argc<0||value.argc>65536
      ||!Array.isArray(value.argv)||value.argv.length!==Math.min(value.argc,12)
      ||value.argv.some(item=>!allowed.has(item))
      ||value.truncated!==(value.argc>12))return null;
    return {schema:value.schema,argc:value.argc,argv:value.argv,truncated:value.truncated};
  }catch{return null;}
}
