/** Compatibility glue in the OLD Bun source only. Rust starts the retained
 * Windows connector without inheriting Bun's listening sockets. */
import {createRequire} from 'node:module';
import {dirname,join,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {stat} from 'node:fs/promises';
import {getConfigDir} from '../config';

export async function nativeQuickLauncher():Promise<string|null>{
  const explicit=process.env.REMODEX_NATIVE_QUICK_LAUNCHER?.trim();
  if(explicit){if(!isAbsolute(explicit)||!(await stat(explicit)).isFile())throw Error('Native connection launcher unavailable');return explicit;}
  try{return join(dirname(createRequire(import.meta.url).resolve('@remodex/native-connect-experiment-win32-x64/package.json')),'remodex-connect-native.exe');}catch{return null;}
}
export async function spawnNativeQuick(binary:string,executable:string,origin:string,protocol:string){
  const directory=join(getConfigDir(),'native-quick-'+randomUUID());
  const launch=Bun.spawn([binary,'--legacy-quick-launch',executable,origin,protocol,directory],{windowsHide:true,detached:true,stdin:'ignore',stdout:'pipe',stderr:'pipe'});
  const [code,raw]=await Promise.all([launch.exited,new Response(launch.stdout).text(),new Response(launch.stderr).text()]);
  if(code!==0||raw.length>8192)throw Error('Native connection launcher failed');
  const config=JSON.parse(raw);if(!Number.isSafeInteger(config.pid)||config.pid<1||config.receipt!==join(directory,'quick-tunnel-process.json'))throw Error('Native connection receipt invalid');
  // Rust saves the verified process record before reporting launch success.
  const record=join(directory,'process.json');
  let finished=false;
  const control=async(operation:'stop'|'wait')=>{
    const p=Bun.spawn([binary,'--legacy-quick-control',operation,record],{windowsHide:true,stdin:'ignore',stdout:'pipe',stderr:'ignore'});
    const [code,raw]=await Promise.all([p.exited,new Response(p.stdout).text()]);
    if(code!==0)throw Error('Native connection process check failed');return raw.trim()==='true';
  };
  const exited=(async()=>{try{await control('wait');return 0;}finally{finished=true;}})();
  const stream=(name:string)=>{let offset=0,cancelled=false;return new ReadableStream<Uint8Array>({async pull(controller){
    try{while(!cancelled){const file=Bun.file(join(directory,name));const size=file.size;if(size>offset){const end=Math.min(size,offset+65536);const bytes=new Uint8Array(await file.slice(offset,end).arrayBuffer());if(cancelled)return;offset=end;controller.enqueue(bytes);return;}if(finished){controller.close();return;}await Bun.sleep(100);}}
    catch(error){if(!cancelled)controller.error(error);}
  },cancel(){cancelled=true;}});};
  return {pid:config.pid,upgradeRetainable:true,stdout:stream('stdout.log'),stderr:stream('stderr.log'),exited,
    kill(){void control('stop').catch(()=>{});}};
}
