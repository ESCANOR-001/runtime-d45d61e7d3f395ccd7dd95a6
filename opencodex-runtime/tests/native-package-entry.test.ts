import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error Node npm entry has no separate declaration build.
import { installationDirectory, packageArguments, installationArguments, managementArguments, tryNativeConnect } from '../bin/native-connect.mjs';

test('published bin keeps the Connect state location and literal paths', () => {
  const home=resolve(tmpdir(),'native home');
  expect(installationDirectory({},home)).toBe(join(home,'.remodex-connect','native-installation'));
  expect(installationDirectory({OPENCODEX_HOME:'~/custom $(literal)'},home)).toBe(join(home,'custom $(literal)','native-installation'));
  const root=join(home,'native-installation');
  expect(packageArguments(['start'],root)).toEqual(['start',root]);
  expect(packageArguments(['start','--port','10100'],root)).toEqual(['--npm-upgrade','start',root,'10100']);
  expect(() => packageArguments(['start','--port','0'],root)).toThrow();
  expect(() => packageArguments(['start','--port','65536'],root)).toThrow();
  expect(packageArguments(['status'],root)).toEqual(['--npm-upgrade','status',root]);
  expect(packageArguments(['--version'],root)).toEqual(['--version']);
  expect(() => packageArguments(['start','foreign'],root)).toThrow();
  expect(packageArguments(['restart'],root)).toEqual(['--npm-upgrade','restart',root]);
  expect(packageArguments(['stop'],root)).toEqual(['--npm-upgrade','stop',root]);
  expect(() => packageArguments(['stop','foreign'],root)).toThrow();
});

test('native setup forwards paths as literal arguments and rejects ambiguous options', () => {
  const root=resolve(tmpdir(),'native $(literal)');
  const pkg=join(root,'package');
  const config=join(root,'setup with spaces.json');
  expect(installationArguments(['onboard','--config',config,'--port','18000'],root,pkg))
    .toEqual(['--native-install','onboard',root,join(pkg,'gui/dist'),'--config',config,'--port','18000']);
  for (const args of [['start','--config',config],['start','--port','65531'],['onboard','--config'],['onboard','--port','80','--port','81']]) {
    expect(()=>installationArguments(args,root,pkg)).toThrow();
  }
});

test('native setup finds a historical profile and refuses ambiguous default installations', async () => {
  const home=await mkdtemp(join(tmpdir(),'native-historical-home-'));
  try {
    await mkdir(join(home,'.opencodex'));
    // Malformed records still prove that this is not an empty new installation.
    await writeFile(join(home,'.opencodex/android-remote.json'),'partial');
    expect(installationDirectory({},home)).toBe(join(home,'.opencodex/native-installation'));
    await mkdir(join(home,'.remodex-connect'));
    await writeFile(join(home,'.remodex-connect/android-remote.json'),'{}');
    expect(()=>installationDirectory({},home)).toThrow('Multiple Remodex installations');
    expect(installationDirectory({OPENCODEX_HOME:join(home,'.opencodex')},home)).toBe(join(home,'.opencodex/native-installation'));
  } finally {await rm(home,{recursive:true,force:true});}
});

test('existing Bun service entry forwards its port without starting the legacy server', async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),'native-service-entry-')));
  try {
    await mkdir(join(root,'src/cli'),{recursive:true});await mkdir(join(root,'bin'));
    await writeFile(join(root,'src/cli/connect.ts'),await readFile(resolve(import.meta.dir,'../src/cli/connect.ts')));
    await writeFile(join(root,'src/cli/index.ts'),"throw new Error('Legacy server must not start after native selection');");
    await writeFile(join(root,'bin/native-connect.mjs'),"export async function tryNativeConnect(root,args) { console.log(JSON.stringify({root,args})); return true; }");
    const child=spawnSync(process.execPath,[join(root,'src/cli/connect.ts'),'--ocx-internal-launch-proof=fixture','start','--port','19043'],{encoding:'utf8',windowsHide:true,shell:false,timeout:5000});
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({root,args:['start','--port','19043']});
  } finally {await rm(root,{recursive:true,force:true});}
});

test('native package selection is explicit, version-bound, and cannot fall back on failure', async () => {
  const root=await mkdtemp(join(tmpdir(),'native-entry-'));
  try {
    expect(await tryNativeConnect(root,['start'])).toBe(false);
    await mkdir(join(root,'bin/native'),{recursive:true});
    await writeFile(join(root,'package.json'),JSON.stringify({version:'0.0.0'}));
    const manifest=join(root,'bin/native-runtime.json');
    await writeFile(manifest,JSON.stringify({formatVersion:1,version:'wrong',backend:'rust',migrationComplete:false}));
    await expect(tryNativeConnect(root,['start'])).rejects.toThrow('does not match');
    await writeFile(manifest,JSON.stringify({formatVersion:1,version:'0.0.0',backend:'rust',migrationComplete:false}));
    await writeFile(join(root,'bin/native/launcher.mjs'),"export const VERSION='0.0.0'; export async function resolveBinary() {} export async function main() { throw new Error('native refused'); }");
    await expect(tryNativeConnect(root,['version'])).rejects.toThrow('native refused');
  } finally {await rm(root,{recursive:true,force:true});}
});

test('missing native artifact fails before a legacy bridge can bootstrap', async () => {
  const root=await mkdtemp(join(tmpdir(),'native-artifact-preflight-'));
  const before=process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME=join(root,'old');
  try {
    await mkdir(join(root,'old'));
    await writeFile(join(root,'old/android-remote.json'),'{}');
    await mkdir(join(root,'bin/native'),{recursive:true});
    await writeFile(join(root,'package.json'),JSON.stringify({version:'0.0.0'}));
    await writeFile(join(root,'bin/native-runtime.json'),JSON.stringify({formatVersion:1,version:'0.0.0',backend:'rust',migrationComplete:false}));
    await writeFile(join(root,'bin/native/launcher.mjs'),"export const VERSION='0.0.0'; export async function resolveBinary() {throw new Error('platform artifact missing');} export async function main() {throw new Error('must not launch');}");
    await expect(tryNativeConnect(root,['start'])).rejects.toThrow('platform artifact missing');
    expect(await readFile(join(root,'old/android-remote.json'),'utf8')).toBe('{}');
    expect(await import('node:fs/promises').then(fs=>fs.readdir(join(root,'old')))).toEqual(['android-remote.json']);
  } finally {
    if (before===undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME=before;
    await rm(root,{recursive:true,force:true});
  }
});


test('native management commands retain revision and literal path boundaries', () => {
  const root=resolve(tmpdir(),'native management');const pkg=join(root,'package');
  const file=join(root,'config $(literal).json');const registration=join(root,'service v2');
  expect(packageArguments(['start'],root,pkg)).toEqual(['--npm-upgrade','start-gui',root,join(pkg,'gui/dist')]);
  expect(packageArguments(['start','--port','10100'],root,pkg)).toEqual(['--npm-upgrade','start-gui',root,join(pkg,'gui/dist'),'10100']);
  expect(managementArguments(['config','apply',file,'--revision','2'],root,pkg)).toEqual(['--native-config','apply',root,file,'--revision','2']);
  expect(managementArguments(['service','prepare',registration],root,pkg)).toEqual(['--native-service','prepare',registration,root,join(pkg,'gui/dist')]);
  expect(managementArguments(['remote','named','phone.example.com','--revision','3'],root,pkg)).toEqual(['--native-remote','named',root,'phone.example.com','--revision','3']);
  for (const args of [['config','apply',file],['config','rollback','-1','--revision','2'],['service','uninstall'],['remote','named','phone.example.com','--token','secret']]) expect(()=>managementArguments(args,root,pkg)).toThrow();
  expect(packageArguments(['features'],root)).toEqual(['--features']);
  expect(packageArguments(['tray'],root)).toEqual(['--retired-feature','tray']);
  expect(packageArguments(['tray','install'],root)).toEqual(['--retired-feature','tray']);
  expect(packageArguments(['preview','start','ignored'],root)).toEqual(['--retired-feature','preview']);
});
