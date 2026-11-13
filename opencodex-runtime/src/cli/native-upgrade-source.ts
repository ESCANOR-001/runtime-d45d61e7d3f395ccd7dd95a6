// Called only by the installed npm launcher's one-time source handoff. The
// native source-hold fence still prevents reopening a migrated installation.
export {};
process.env.REMODEX_CONNECT_ONLY = '1';
process.env.OCX_NATIVE_UPGRADE_SOURCE = '1';
await import('./index');
