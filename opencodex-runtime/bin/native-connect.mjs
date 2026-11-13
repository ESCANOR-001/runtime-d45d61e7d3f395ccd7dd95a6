// Package-local native selection. npm install never invokes this module. An
// explicit rmx start discovers the source handoff in this installation's state.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bootstrapSource, needsSourceBootstrap, installationKind } from './native-bootstrap.mjs';

export function installationDirectory(env = process.env, home = homedir()) {
  let raw = env.OPENCODEX_HOME?.trim();
  if (!raw) {
    const candidates = ['.remodex-connect','.remodex','.opencodex'].map(name=>join(home,name));
    const present = path => {
      try {lstatSync(path);return true;}
      catch(error) {if(error.code==='ENOENT')return false;throw error;}
    };
    const known = candidates.filter(root=>['android-remote.json','native-upgrade-source-hold.json',
      'native-installation/native-install.json','native-installation/npm-source.json','native-installation/npm-upgrade.sqlite']
      .some(name=>present(join(root,name))));
    if(known.length>1)throw new Error('Multiple Remodex installations were found. Set OPENCODEX_HOME to the installation you want to start or upgrade; none was changed.');
    raw=known[0] ?? candidates[0];
  }
  const expanded = raw === '~' ? home : /^~[/\\]/.test(raw) ? join(home, raw.slice(2)) : raw;
  return join(resolve(expanded), 'native-installation');
}
export function packageArguments(args, installation, packageRoot) {
  if (args.length === 0 || args.length === 1 && ['help','--help','-h'].includes(args[0])) return ['--help'];
  if (['tray','__tray-host','__tray-start','__tray-restart','terminal','preview'].includes(args[0])) return ['--retired-feature',args[0]];
  const start = packageRoot ? ['--npm-upgrade','start-gui',installation,join(packageRoot,'gui/dist')] : ['--npm-upgrade','start',installation];
  if (args.length === 3 && args[0] === 'start' && args[1] === '--port' && /^[1-9][0-9]{0,4}$/.test(args[2]) && Number(args[2]) <= 65535) return [...start,args[2]];
  if (args.length !== 1) throw new Error('Native Remodex expects one command; installation paths come from OPENCODEX_HOME.');
  switch (args[0]) {
    case 'features': return ['--features'];
    case 'start': return packageRoot ? start : ['start', installation];
    case 'status': case 'stop': case 'restart': return ['--npm-upgrade', args[0], installation];
    case 'version': case '--version': case '-v': return ['--version'];
    default: throw new Error(`'${args[0]}' is not yet qualified for the native package. No legacy backend was started.`);
  }
}
export function installationArguments(args, installation, packageRoot) {
  if (!['start','onboard'].includes(args[0])) throw new Error('Expected start or onboard');
  const seen = new Set();
  for (let i=1;i<args.length;i+=2) {
    const option=args[i], value=args[i+1];
    if (!value || seen.has(option) || !['--port',...(args[0]==='onboard'?['--config']:[])].includes(option)) {
      throw new Error('Usage: rmx start [--port PORT] | rmx onboard [--port PORT] [--config FILE]');
    }
    if (option==='--port' && (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value)>65530)) throw new Error('Choose a dashboard port between 1 and 65530.');
    seen.add(option);
  }
  const forwarded=args.slice(1).map((value,i,all)=>i>0&&all[i-1]==='--config'?resolve(value):value);
  return ['--native-install',args[0],installation,join(packageRoot,'gui/dist'),...forwarded];
}
export function managementArguments(args, installation, packageRoot) {
  const [command, operation, ...rest] = args;
  if (command === 'config') {
    if (operation === 'show' && rest.length === 0) return ['--native-config', operation, installation];
    if (operation === 'check' && rest.length === 1) return ['--native-config', operation, installation, resolve(rest[0])];
    if (['apply','rollback'].includes(operation) && rest.length === 3 && rest[1] === '--revision' && /^\d+$/.test(rest[2]) && (operation !== 'rollback' || /^\d+$/.test(rest[0]))) return ['--native-config',operation,installation,operation === 'apply' ? resolve(rest[0]) : rest[0],...rest.slice(1)];
    throw new Error('Usage: rmx config show | check FILE | apply FILE --revision N | rollback N --revision N');
  }
  if (command === 'remote') {
    if (operation === 'provision' && rest.length === 5 && rest[3] === '--revision' && /^\d+$/.test(rest[4])) return ['--native-provision',installation,...rest];
    if (['local','quick'].includes(operation) && rest.length === 2 && rest[0] === '--revision' && /^\d+$/.test(rest[1])) return ['--native-remote',operation,installation,...rest];
    if (operation === 'named' && rest.length === 3 && rest[1] === '--revision' && /^\d+$/.test(rest[2])) return ['--native-remote',operation,installation,...rest];
    throw new Error('Usage: rmx remote local|quick --revision N | named HOST --revision N (token on stdin)');
  }
  if (command === 'service') {
    if (operation === 'prepare' && rest.length === 1) return ['--native-service',operation,resolve(rest[0]),installation,join(packageRoot,'gui/dist')];
    if (['install','start','status','uninstall'].includes(operation) && rest.length === 1) return ['--native-service',operation,resolve(rest[0])];
    if (operation === 'replace' && rest.length === 2) return ['--native-service',operation,...rest.map(p=>resolve(p))];
    throw new Error('Usage: rmx service prepare|install|start|status|uninstall DIR | replace NEW_DIR OLD_DIR');
  }
  return null;
}
export async function tryNativeConnect(packageRoot, args = process.argv.slice(2)) {
  const metadata = join(packageRoot,'bin/native-runtime.json');
  let stat;
  try { stat = await lstat(metadata); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('Invalid native package selection.');
  const m = JSON.parse(await readFile(metadata,'utf8'));
  const pkg = JSON.parse(await readFile(join(packageRoot,'package.json'),'utf8'));
  if (m.formatVersion !== 1 || m.version !== pkg.version || m.backend !== 'rust' || m.migrationComplete !== false) throw new Error('Native package selection does not match this release.');
  const modulePath=join(packageRoot,'bin/native/launcher.mjs');
  const moduleStat=await lstat(modulePath);
  if (!moduleStat.isFile() || moduleStat.isSymbolicLink() || await realpath(modulePath) !== join(await realpath(packageRoot),'bin/native/launcher.mjs')) throw new Error('Invalid native launcher path.');
  const launcher=await import(pathToFileURL(modulePath).href);
  if (launcher.VERSION !== m.version) throw new Error('Native launcher version mismatch.');
  const installation = installationDirectory();
  const kind = await installationKind(installation);
  if (args[0]==='onboard' && kind==='legacy') throw new Error('This PC already has a legacy installation. Run rmx start to upgrade it while retaining its chats and pairing.');
  const management = managementArguments(args, installation, packageRoot);
  const nativeArgs = management ?? (['start','onboard'].includes(args[0]) && kind!=='legacy'
    ? installationArguments(args,installation,packageRoot) : packageArguments(args, installation, packageRoot));
  // Verify the native artifact before launching or retiring any compatibility
  // owner. A missing platform package must leave the old service untouched.
  await launcher.resolveBinary();
  if (args[0] === 'start' && await needsSourceBootstrap(installation)) {
    await bootstrapSource(packageRoot, installation, launcher.prepareSource, args.slice(1));
  }
  await launcher.main(nativeArgs);
  return true;
}
