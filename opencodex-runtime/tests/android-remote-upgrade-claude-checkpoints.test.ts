import { test,expect } from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {reconcileUpgradeCheckpoints} from '../src/android-remote/upgrade-claude-checkpoints';
test('upgrade retains phantom checkpoint metadata without offering a native file restore',async()=>{
 const root=await mkdtemp(join(tmpdir(),'upgrade-checkpoints-'));
 try {
  const path=join(root,'native.jsonl');const bytes=[{type:'user',sessionId:'native',uuid:'interrupted'},{type:'file-history-snapshot',messageId:'real',snapshot:{trackedFileBackups:{}}}].map(v=>JSON.stringify(v)+'\n').join('');await writeFile(path,bytes);
  const source={nativeId:'native',fileCheckpoints:[{id:'real',label:'Before edit'},{id:'interrupted',label:'Interrupted'}],thread:{messages:[{text:'Keep history'}]}};const before=JSON.stringify(source);
  const result=await reconcileUpgradeCheckpoints(source,path);
  expect(result.fileCheckpoints).toEqual([source.fileCheckpoints[0]]);
  expect(result.retainedFileCheckpoints).toEqual([source.fileCheckpoints[1]]);
  expect(result.thread).toEqual(source.thread);expect(JSON.stringify(source)).toBe(before);expect(await readFile(path,'utf8')).toBe(bytes);
  await writeFile(path,'{"type":"user","sessionId":"other"}\n');await expect(reconcileUpgradeCheckpoints(source,path)).rejects.toThrow();
  await writeFile(path,'{"type":"file-history-snapshot"');await expect(reconcileUpgradeCheckpoints(source,path)).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
