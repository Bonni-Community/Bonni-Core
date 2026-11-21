import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const backend=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const metadata=JSON.parse(await readFile(path.join(backend,'package.json'),'utf8'));
if(metadata.version!=='0.1.20+h-DEV.67')throw new Error('GOURMET_BASIS_CORE_VERSION_MISMATCH');
process.env.SYSTEM_VERSION ||= metadata.version;
const {initializeDatabaseRouting,disconnectPrismaClients}=await import('../../dist/core/database/database.js');
const {listInstalledModulesStrict}=await import('../../dist/platform/module-manager/registry/index.js');
const {findModuleManifest}=await import('../../dist/platform/module-manager/manifests/index.js');
const {installModulePackage,activateModulePackage}=await import('../../dist/platform/module-manager/install/module-install.service.js');
const {deactivateRuntimeModule}=await import('../../dist/platform/module-manager/loader/index.js');
try{
 await initializeDatabaseRouting();
 if((await listInstalledModulesStrict()).some(module=>module.installed&&module.key==='addon.hub'))throw new Error('GOURMET_BASIS_REQUIRES_MATCHING_HUB_CORE: Hub DEV02 belongs to its original Core; this basis is verified without Hub.');
 for(const [key,version] of [['app.stueberlapp','0.2.2+a-DEV49'],['addon.gourmet','0.1.0+a-DEV.8']]){
  const manifest=await findModuleManifest(key);
  if(manifest?.version!==version)throw new Error('GOURMET_BASIS_PARTNER_VERSION_MISMATCH:'+key);
  const installation=await installModulePackage(key);
  if(!installation.ok)throw new Error('GOURMET_BASIS_INSTALL_FAILED:'+key+':'+JSON.stringify(installation));
  const activation=await activateModulePackage(key);
  if(!activation.ok)throw new Error('GOURMET_BASIS_ACTIVATION_FAILED:'+key+':'+JSON.stringify(activation));
  console.info('Bereit: '+key+' '+version);
 }
}finally{
 await deactivateRuntimeModule('addon.gourmet');await deactivateRuntimeModule('app.stueberlapp');
 await disconnectPrismaClients();
}
