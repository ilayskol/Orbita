'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createSettingsStore,sanitizeConfig,MAX_BYTES}=require('./settings.cjs');
const draft=()=>({version:1,offers:[],template:[],ownWebs:[],statuses:['approved','1'],commissionRate:'',commissionMode:'grossup',decimal:',',filterMonth:false,timeMode:'source'});
const configured=()=>({...draft(),offers:[{id:102,name:'demo_offer_10',company:'FCN',country:'RU'}],template:[{offer:'demo_offer_10',company:'FCN',web:8888,country:'RU'}],ownWebs:[1001,1002]});
// macOS /var is a system alias of /private/var. Exercise the canonical profile
// path, just as Application Support does, without weakening symlink checks.
async function fixture(t){const parent=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'orbita-settings-')));t.after(()=>fs.rm(parent,{recursive:true,force:true}));return {parent,root:path.join(parent,'profile')};}

test('fresh profile marker persists empty draft independently of archives',async t=>{
  const {root}=await fixture(t);const store=createSettingsStore(root);
  assert.deepEqual(await store.load(),{config:null,legacy:false});await store.save(draft());
  assert.deepEqual(await createSettingsStore(root,{legacy:true}).load(),{config:draft(),legacy:true});
  assert.deepEqual(await fs.readdir(root),['settings.json']);
});
test('legacy flag preserved until first save; normalized whitelist roundtrip',async t=>{
  const {root}=await fixture(t);const store=createSettingsStore(root,{legacy:true});assert.deepEqual(await store.load(),{config:null,legacy:true});
  const input=configured();input.customerRecords=[{secret:'not settings'}];input.offers[0].extra='discard';input.template[0].extra='discard';
  await store.save(input);const saved=(await createSettingsStore(root).load()).config;
  assert.deepEqual(saved,sanitizeConfig(configured()));assert.equal(saved.template[0].web,33);
  assert.equal((await fs.readFile(path.join(root,'settings.json'),'utf8')).includes('secret'),false);
});
test('reject malformed values without replacing previous settings',async t=>{
  const {root}=await fixture(t);const store=createSettingsStore(root);await store.save(configured());
  for(const patch of [{offers:[{id:-1}]},{statuses:[]},{ownWebs:[0]},{decimal:';'},{commissionRate:'100'},{filterMonth:'true'},{template:new Array(5001).fill({})},{statuses:[1]}])await assert.rejects(store.save({...draft(),...patch}));
  assert.deepEqual((await store.load()).config,sanitizeConfig(configured()));
});
test('corrupt and oversized files are errors, not silent defaults',async t=>{
  const {root}=await fixture(t);const store=createSettingsStore(root);await store.save(draft());const file=path.join(root,'settings.json');
  await fs.writeFile(file,'{bad');await assert.rejects(store.load(),/повреждён/);
  await fs.writeFile(file,' '.repeat(MAX_BYTES+1));await assert.rejects(store.load(),/слишком большой/);await assert.rejects(store.save(draft()));
});
test('failed atomic replacement keeps old settings and removes temporary file',async t=>{
  const {root}=await fixture(t);await createSettingsStore(root).save(configured());
  const io=Object.create(fs);io.rename=async()=>{throw new Error('test rename failure');};
  await assert.rejects(createSettingsStore(root,{io}).save(draft()),/test rename failure/);
  assert.deepEqual((await createSettingsStore(root).load()).config,sanitizeConfig(configured()));assert.deepEqual(await fs.readdir(root),['settings.json']);
});
test('serialized saves and flush preserve latest settings',async t=>{
  const {root}=await fixture(t);const store=createSettingsStore(root);const first=store.save(configured()),second=store.save(draft());await store.flush();await Promise.all([first,second]);
  assert.deepEqual((await createSettingsStore(root).load()).config,draft());
});
test('directory links cannot redirect reads or writes outside profile',async t=>{
  const {parent,root}=await fixture(t);const outside=path.join(parent,'outside');await fs.mkdir(outside);
  try{await fs.symlink(outside,root,process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symlink privilege unavailable');return;}throw error;}
  const store=createSettingsStore(root);await assert.rejects(store.load(),/ссылкой/);await assert.rejects(store.save(draft()),/ссылкой/);assert.deepEqual(await fs.readdir(outside),[]);
});
test('settings file links cannot expose or overwrite another file',async t=>{
  const {parent,root}=await fixture(t);await fs.mkdir(root);const outside=path.join(parent,'outside.json');await fs.writeFile(outside,JSON.stringify(draft()));
  try{await fs.symlink(outside,path.join(root,'settings.json'),'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symlink privilege unavailable');return;}throw error;}
  const store=createSettingsStore(root);await assert.rejects(store.load(),/повреждён/);await assert.rejects(store.save(configured()),/повреждён/);assert.deepEqual(JSON.parse(await fs.readFile(outside,'utf8')),draft());
});
