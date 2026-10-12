import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { NativeDesktop } from '../chat/desktop-native.mjs';
import { nativeCall } from '../chat/native-helper.mjs';
import { extractMessages, historyPage, displayDate, hash, stableJson } from '../chat/desktop-content.mjs';

const sessionId = '11111111-1111-1111-1111-111111111111';
const node = (role, name = '', children = [], parent = null, attrs = {}) => ({ role, name, children, parent, attrs, class:'' });
const tree = () => ({ application: ':1.42', order: ['doc','entry','model','article','heading','body','p','bold','t','end'], nodes: {
  doc: { ...node('document web'), document: { URI: 'https://claude.ai/chat/' + sessionId, Title:'Test - Claude' } },
  entry: node('entry','Write your prompt to Claude'), model: node('button','Model: Haiku 5.5 Medium'),
  article: node('article','',['heading','body']), heading: node('heading','Claude responded: Hello',[],'article'),
  body: node('section','',['p'],'article'), p: node('paragraph','',['bold','end'],'body'),
  bold: node('static','',['t'],'p',{tag:'strong'}), t: node('static','Hello',[],'bold'), end: node('static',' world',[],'p'),
} });
const setup = () => {
  let current = tree(); const calls = [];
  const desktop = new NativeDesktop(async request => {calls.push(request); if (request.op === 'scan') return structuredClone(current); return {};}, async () => {});
  return {desktop,calls,get tree(){return current;},set tree(value){current=value;}};
};

test('native snapshot preserves markdown, stable revision and selected model identity', async () => {
  const x = setup(), state = await x.desktop.scan();
  assert.equal(state.model,'Haiku 5.5'); assert.equal(state.sessionId,sessionId);
  assert.deepEqual(state.messages,[{role:'assistant',text:'**Hello** world'}]);
  assert.equal(state.revision,hash(stableJson([sessionId,state.model,state.messages])));
  assert.equal(state.draftPresent,false);assert.equal(state.draftHash,null);
});
test('ambiguous Desktop documents and dialogs cannot be treated as ready snapshots', async () => {
  const x = setup(); x.tree.nodes.alert=node('alert','A dialog');
  await assert.rejects(x.desktop.scan(),/dialog/);
  delete x.tree.nodes.alert; x.tree.nodes.other=structuredClone(x.tree.nodes.doc);
  await assert.rejects(x.desktop.scan(),/regular Claude Chat/);
});
test('stale revision and unsent draft reject send before any native mutation', async () => {
  const x = setup(); const state = await x.desktop.scan();
  await assert.rejects(x.desktop.send({...state,revision:'stale',text:'Hello'}),/changed/);
  x.tree.nodes.entry.children=['draft']; x.tree.nodes.draft=node('static','Unsent');
  await assert.rejects(x.desktop.send({...state,text:'Hello'}),/unsent draft/);
  assert(x.calls.every(r=>r.op==='scan'));
});
test('unsupported operations and malformed images do not touch Desktop', async () => {
  const x=setup();assert.throws(()=>x.desktop.execute({op:'shell'}),/Unknown/);
  await assert.rejects(x.desktop.send({image:{mime:'image/png',data:'bad'}}),/PNG/);
  assert.equal(x.calls.length,0);
});
test('navigation honors stable targetSessionId, protects drafts, and uses Desktop New control', async () => {
  const x=setup(),state=await x.desktop.scan();
  assert.equal((await x.desktop.navigate({...state,op:'open',targetSessionId:sessionId})).sessionId,sessionId);
  await assert.rejects(x.desktop.navigate({...state,op:'open',targetSessionId:'bad'}),/Invalid chat identity/);
  x.desktop.action=async name=>assert.equal(name,'New');
  x.desktop.awaitState=async predicate=>{assert(predicate({sessionId:'new'}));return {sessionId:'new'};};
  await x.desktop.navigate({...state,op:'new'});
});
test('history validates identity and page cursors without losing or duplicating messages', async () => {
  const x=setup(),state=await x.desktop.scan();
  await assert.rejects(x.desktop.history({...state,revision:'stale'}),/changed/);
  const messages=Array.from({length:135},(_,i)=>({role:'user',text:String(i)}));
  let before=messages.length,collected=[];
  do {const page=historyPage(messages,before);collected=[...page.messages,...collected];before=page.start;} while(before);
  assert.deepEqual(collected,messages);
  for(const invalid of [-1,true,NaN,136,null])assert.throws(()=>historyPage(messages,invalid),/History changed/);
  assert.equal(historyPage(Array.from({length:5},()=>({role:'assistant',text:'界'.repeat(60000)}))).messages.length,1);
});
test('display dates retain precision and validate invalid calendar dates', () => {
  const now=new Date(2026,9,12,9,25);
  assert.equal(displayDate('Today',now),new Date(2026,9,12).toISOString().replace('.000Z','Z'));
  assert.equal(displayDate('Feb 16',now),new Date(2026,1,16).toISOString().replace('.000Z','Z'));
  assert.equal(displayDate('Dec 31',now),new Date(2025,11,31).toISOString().replace('.000Z','Z'));
  for(const label of ['chat title','Feb 31','Never 12'])assert.equal(displayDate(label,now),null);
});
test('model submenu verifies hover fallback and excludes upgrade entries', async () => {
  const x=setup();const d=x.desktop;let hovered=false,closed=false;
  d.scan=async()=>{d.nodes={model:node('button','Model: Haiku 5.5 Medium'),more:node('menu item','More models'),haiku:node('radio menu item','Haiku 5.5 Fastest for quick answers'),upgrade:node('menu item','Opus Pro Upgrade')};
    if(hovered){d.nodes.menu=node('menu','More models');d.nodes.sonnet=node('radio menu item','Sonnet 5.5');}
    d.order=Object.keys(d.nodes);return {};};
  d.action=async name=>{if(name.startsWith('Model:')&&hovered)closed=true;};
  d.actId=async(id,op)=>{assert.equal(id,'more');assert.equal(op,'hover');hovered=true;};
  assert.deepEqual((await d.models()).models.map(m=>m.label),['Haiku 5.5','Sonnet 5.5']);assert(closed);
});
test('a submenu that never opens fails instead of caching a partial model list', async () => {
  const x=setup(),d=x.desktop;let closed=false;
  d.scan=async()=>{d.nodes={model:node('button','Model: Haiku 5.5'),more:node('menu item','More models')};d.order=Object.keys(d.nodes);return {};};
  d.action=async name=>{if(name.startsWith('Model:'))closed=true;};d.actId=async()=>{};
  await assert.rejects(d.models(),/complete model list/);assert(closed);
});
test('clipboard is restored on failure and user clipboard changes are preserved', async () => {
  let clipboard={mime:'text/plain;charset=utf-8',data:Buffer.from('original').toString('base64')};
  const d=new NativeDesktop(async r=>{if(r.op==='clipboardRead')return {...clipboard};clipboard={mime:r.mime,data:r.data};return {};});
  await assert.rejects(d.clipboard('test','text/plain;charset=utf-8',async()=>{throw new Error('Paste failed');}),/Paste failed/);
  assert.equal(Buffer.from(clipboard.data,'base64').toString(),'original');
  await d.clipboard('test','text/plain;charset=utf-8',async()=>{clipboard.data=Buffer.from('user copied').toString('base64');});
  assert.equal(Buffer.from(clipboard.data,'base64').toString(),'user copied');
});
test('wrong prepared draft is never submitted and send acknowledgement is not retried', async () => {
  const d=new NativeDesktop();let sends=0;
  d.idleTarget=async()=>{};d.checkTarget=async()=>{};d.call=async()=>{};d.find=()=> 'entry';d.actId=async()=>{};
  d.clipboard=async(_text,_mime,run)=>run();d.pasteMenu=async()=>{};d.wait=async()=>{};
  d.attachments=()=>[];d.draft=()=> 'different';d.action=async()=>{sends++;};
  await assert.rejects(d.send({text:'expected'}),/prepared message changed/);assert.equal(sends,0);
  d.draft=()=> 'expected';d.awaitState=async()=>{throw new Error('Acknowledgement lost');};
  await assert.rejects(d.send({text:'expected'}),/Acknowledgement lost/);assert.equal(sends,1);
});
test('empty catalog render is never reported as a complete empty account', async () => {
  const d=new NativeDesktop(undefined,async()=>{});let scans=0,back=false;
  d.scan=async()=>{d.nodes={};d.order=[];return scans++===0?{sessionId,busy:false,draftPresent:false}:{sessionId:'catalog'};};
  d.action=async name=>{if(name==='Back')back=true;};d.awaitState=async()=>({sessionId});
  await assert.rejects(d.catalog(),/still loading/);assert(back);
});
test('native subprocess is hidden and failed or malformed actions are never replayed', async () => {
  for(const mode of ['failed','malformed','timeout']) {
    let starts=0,killed=false;
    const spawnProcess=(_binary,args,options)=>{
      starts++;assert.deepEqual(args,[]);assert.equal(options.windowsHide,true);
      const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{killed=true;};
      child.stdin.on('finish',()=>{
        if(mode==='timeout')return;
        child.stdout.write(mode==='malformed'?'incomplete':JSON.stringify({ok:false,error:'No replay'}));child.emit('close',1);
      });return child;
    };
    await assert.rejects(nativeCall({op:'action'},{spawnProcess,timeout:20}));assert.equal(starts,1);
    assert.equal(killed,mode==='timeout');
  }
});
