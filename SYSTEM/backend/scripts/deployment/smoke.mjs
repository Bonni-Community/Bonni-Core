// GitHub Actions executes this exact signed source after building. It exercises
// normal installation (including runner), graceful restart and a killed
// controller, then tears down only this run's disposable project.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {cleanupSmokeProject,withSmokeCleanup} from './smoke-cleanup.mjs';
import {testControllerRecovery} from './smoke-recovery.mjs';
const mode=process.argv[2],env=process.env;
if(!['online','offline'].includes(mode)||!/^\d+$/.test(env.GITHUB_RUN_ID||'')||!/^\d+$/.test(env.GITHUB_RUN_ATTEMPT||''))throw Error('SMOKE_CI_CONTEXT_REQUIRED');
const docker=(args,stdio='pipe')=>execFileSync('docker',args,{encoding:'utf8',stdio,timeout:20*60_000,maxBuffer:8*1024*1024});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(const platform of env.PLATFORMS.split(',')){
  const arch={'linux/amd64':'amd64','linux/arm64':'arm64','linux/arm/v7':'armv7'}[platform];if(!arch)throw Error('SMOKE_PLATFORM_INVALID');
  const file='smoke/'+arch+(mode==='offline'?'-offline':'')+'.yml';
  const project=`bonni-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${arch}`;
  const compose=['compose','-p',project,'-f',file];
  const run=args=>docker([...compose,...args],'inherit');
  const script=code=>docker([...compose,'exec','-T','bonni-core','node','-e',code]).trim();
  const root=`/tmp/bonni-deployment-ci-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${arch}`;
  // No pre-existing installation is ever reused for a smoke test.
  if(await fs.lstat(root).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))throw Error('SMOKE_ROOT_ALREADY_EXISTS');
  // Owned by the runner so its empty root can be removed without sudo after
  // the cleanup container has released the bind mount.
  await fs.mkdir(root,{mode:0o755});
  await withSmokeCleanup({test:async()=>{
  try{
    run(['config','--quiet']);
    if(mode==='offline')execFileSync(process.execPath,['load-offline-images.mjs'],{env:{...env,PLATFORM:platform},stdio:'inherit'});
    else run(['--profile','bonni-images','pull']);
    const images=docker([...compose,'--profile','bonni-images','config','--images']).trim().split('\n');
    for(const image of images){
      const detail=JSON.parse(docker(['image','inspect',image]))[0];
      const actual=detail.Os+'/'+detail.Architecture+(detail.Architecture==='arm'?'/'+detail.Variant:'');
      if(actual!==platform)throw Error('SMOKE_IMAGE_PLATFORM_MISMATCH');
    }
    run(['up','-d','--pull','never','--wait','--wait-timeout','1200']);
    const probe="fetch('http://127.0.0.1:4000/').then(async r=>{if(!r.ok||!(await r.text()).includes('<html'))process.exit(1)}).catch(()=>process.exit(1))";
    script(probe);
    const before=script("const fs=require('fs'),p=process.env.BONNI_HOST_PROJECT_ROOT;fs.writeFileSync(p+'/UPDATE/deployment-smoke','preserve');process.stdout.write(fs.readFileSync(p+'/.bonni-deployment.json','utf8'))");
    run(['restart','bonni-core']);
    run(['up','-d','--pull','never','--wait','--wait-timeout','1200']);
    const identity=()=>script("const fs=require('fs'),p=process.env.BONNI_HOST_PROJECT_ROOT;if(fs.readFileSync(p+'/UPDATE/deployment-smoke','utf8')!=='preserve')process.exit(1);process.stdout.write(fs.readFileSync(p+'/.bonni-deployment.json','utf8'))");
    if(identity()!==before)throw Error('SMOKE_PERSISTED_STATE_CHANGED');
    script(probe);
    const id=docker([...compose,'ps','-q','bonni-core']).trim();
    await testControllerRecovery({docker,id,project,root,delay});
    if(identity()!==before)throw Error('SMOKE_RECOVERY_CHANGED_STATE');
    script(probe);
    console.log(platform+': Core, Datenbank, Notlauf, Proxy und Update-Dienst nach Erststart/Neustart/Controller-Abbruch gesund.');
  }catch(error){try{run(['logs','--tail','100']);}catch{}throw error;}
  },cleanup:()=>cleanupSmokeProject({run,root})});
  if(mode==='offline')for(const image of docker([...compose,'--profile','bonni-images','config','--images']).trim().split('\n'))docker(['image','rm',image],'inherit');
}
