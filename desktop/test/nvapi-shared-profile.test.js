'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native official shared writes preserve applications and reject scope drift, global and custom profiles', { skip: process.platform !== 'win32' }, () => {
  const helper = fs.readFileSync(path.join(__dirname, '..', 'src', 'product', 'nvapi-profile.ps1'), 'utf8');
  const source = helper.match(/\$source = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
  const harness = String.raw`
public static class SharedProfileProbe {
  static readonly string Exe=@"C:\Games\Example\game.exe";
  static readonly uint[] Ids={0x10AFB768,0x10E41E01,0x10E41DF3,0x10E41DF5,0x10308298,0x104D6667,0x10562D0F,0x10CF4125};
  static System.Type Owner=typeof(ZhuangjizhaiNvapiProfile.Bridge), ApiType=Owner.GetNestedType("Api",System.Reflection.BindingFlags.NonPublic);
  static System.Collections.Generic.List<ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION> Apps;
  static System.Collections.Generic.Dictionary<uint,uint> Values;
  static uint Predefined; static bool Global, DriftAfterSave, FailEnumeration;
  static int Sets, Deletes, Saves, ProfileMutations;
  static System.Web.Script.Serialization.JavaScriptSerializer Json() { var js=new System.Web.Script.Serialization.JavaScriptSerializer();js.RegisterConverters(new[]{new ZhuangjizhaiNvapiProfile.ProfileConverter()});return js; }
  static T Clone<T>(T value) { var js=Json();return js.Deserialize<T>(js.Serialize(value)); }
  static ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION App(string name) { return new ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION{appName=name,userFriendlyName="Official game",launcher="",fileInFolder="",commandLine="",isPredefined=1}; }
  static void Reset() { Apps=new System.Collections.Generic.List<ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION>{App("example/game.exe"),App("example/game_dx11.exe")};Values=new System.Collections.Generic.Dictionary<uint,uint>{{0xDEADBEEF,42}};Predefined=1;Global=false;DriftAfterSave=false;FailEnumeration=false;Sets=Deletes=Saves=ProfileMutations=0; }
  public static int FindApp(System.IntPtr session,string exe,out System.IntPtr profile,ref ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION app) { profile=new System.IntPtr(1);if(exe!=Exe)return -166;app=Apps.First(a=>a.appName=="example/game.exe");return 0; }
  public static int GetProfile(System.IntPtr session,System.IntPtr profile,ref ZhuangjizhaiNvapiProfile.NVDRS_PROFILE info) { info.profileName="Official shared game";info.isPredefined=Predefined;info.numOfApps=(uint)Apps.Count;info.numOfSettings=(uint)Values.Count;return 0; }
  public static int GetGlobal(System.IntPtr session,out System.IntPtr profile) { profile=new System.IntPtr(Global?1:2);return 0; }
  public static int EnumApps(System.IntPtr session,System.IntPtr profile,uint index,ref uint count,ref ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION app) { if(FailEnumeration)return -175;if(index>=Apps.Count){count=0;return -7;}app=Apps[(int)index];count=1;return 0; }
  public static int GetSetting(System.IntPtr session,System.IntPtr profile,uint id,ref ZhuangjizhaiNvapiProfile.NVDRS_SETTING setting) { uint value;if(!Values.TryGetValue(id,out value))return -160;setting.settingId=id;setting.settingLocation=0;setting.isCurrentPredefined=0;setting.currentValue.u32Value=value;return 0; }
  public static int SetSetting(System.IntPtr session,System.IntPtr profile,ref ZhuangjizhaiNvapiProfile.NVDRS_SETTING setting) { Sets++;Values[setting.settingId]=setting.currentValue.u32Value;return 0; }
  public static int DeleteSetting(System.IntPtr session,System.IntPtr profile,uint id) { Deletes++;return Values.Remove(id)?0:-160; }
  public static int Save(System.IntPtr session) { Saves++;if(DriftAfterSave){var app=Apps[1];app.commandLine="external-change";Apps[1]=app;}return 0; }
  public static int Load(System.IntPtr session) { return 0; }
  public static int DeleteProfile(System.IntPtr session,System.IntPtr profile) { ProfileMutations++;return -1; }
  public static int CreateProfile(System.IntPtr session,ref ZhuangjizhaiNvapiProfile.NVDRS_PROFILE info,out System.IntPtr profile) { ProfileMutations++;profile=System.IntPtr.Zero;return -1; }
  public static int CreateApp(System.IntPtr session,System.IntPtr profile,ref ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION app) { ProfileMutations++;return -1; }
  static object Api() {
    // Do not execute the Api constructor: every native call is an in-memory delegate.
    object api=System.Runtime.Serialization.FormatterServices.GetUninitializedObject(ApiType);
    foreach(string name in new[]{"FindApp","GetProfile","GetGlobal","EnumApps","GetSetting","SetSetting","DeleteSetting","DeleteProfile","CreateProfile","CreateApp","SaveSettings","LoadSettings"}) {
      var field=ApiType.GetField(name);string callback=name=="SaveSettings"?"Save":name=="LoadSettings"?"Load":name;
      field.SetValue(api,System.Delegate.CreateDelegate(field.FieldType,typeof(SharedProfileProbe).GetMethod(callback)));
    }
    return api;
  }
  static object Invoke(string name,params object[] args) { try{return Owner.GetMethod(name,System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static).Invoke(null,args);}catch(System.Reflection.TargetInvocationException e){throw e.InnerException;} }
  static ZhuangjizhaiNvapiProfile.Snapshot Read(object api) { return (ZhuangjizhaiNvapiProfile.Snapshot)Invoke("ReadSnapshot",api,Exe,Ids,null); }
  static ZhuangjizhaiNvapiProfile.Snapshot Desired(ZhuangjizhaiNvapiProfile.Snapshot baseline) { var result=Clone(baseline);uint index=1;foreach(uint id in Ids)result.settings[id.ToString()]=new ZhuangjizhaiNvapiProfile.SettingState{kind="explicit",value=index++,location=0,predefined=false};return result; }
  static ZhuangjizhaiNvapiProfile.Snapshot Write(object api,ZhuangjizhaiNvapiProfile.Snapshot before,ZhuangjizhaiNvapiProfile.Snapshot after,uint[] ids=null) { var request=new ZhuangjizhaiNvapiProfile.Request{op="write",exe=Exe,ids=ids??Ids,expectedSnapshot=before,desiredSnapshot=after};Invoke("Validate",request);return (ZhuangjizhaiNvapiProfile.Snapshot)Invoke("Write",api,Exe,request); }
  static string Error(System.Action action) { try{action();return null;}catch(ZhuangjizhaiNvapiProfile.AdapterException e){return e.Code;} }
  static object Counts(string code) { return new{code=code,sets=Sets,deletes=Deletes,saves=Saves,profileMutations=ProfileMutations}; }
  public static string Run() {
    var output=new System.Collections.Generic.Dictionary<string,object>();
    Reset();object api=Api();var baseline=Read(api);string rules=Json().Serialize(Apps);
    var applied=Write(api,baseline,Desired(baseline));var restored=Write(api,applied,baseline);
    output["roundtrip"]=new{exact=Json().Serialize(restored)==Json().Serialize(baseline),rulesUnchanged=rules==Json().Serialize(Apps),untouchedValue=Values[0xDEADBEEF],sets=Sets,deletes=Deletes,saves=Saves,profileMutations=ProfileMutations,profile=restored.profile};
    output["inspection"]=Invoke("InspectScope",api,Exe);
    Reset();api=Api();baseline=Read(api);Apps.Reverse();var reordered=Read(api);output["orderIndependent"]=baseline.profile.scope.fingerprint==reordered.profile.scope.fingerprint;output["reorderedWrite"]=Error(()=>Write(api,baseline,Desired(baseline)));
    var fieldChanges=new System.Collections.Generic.Dictionary<string,object>();
    foreach(string field in new[]{"appName","userFriendlyName","launcher","fileInFolder","flags","commandLine","isPredefined"}) {
      Reset();api=Api();baseline=Read(api);object app=Apps[1];typeof(ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION).GetField(field).SetValue(app,field=="flags"||field=="isPredefined"?(object)(uint)2:"changed");Apps[1]=(ZhuangjizhaiNvapiProfile.NVDRS_APPLICATION)app;
      string code=Error(()=>Write(api,baseline,Desired(baseline)));fieldChanges[field]=Counts(code);
    }
    output["ruleChanges"]=fieldChanges;
    Reset();api=Api();baseline=Read(api);Apps.Add(App("example/another.exe"));output["applicationAdded"]=Counts(Error(()=>Write(api,baseline,Desired(baseline))));
    Reset();api=Api();baseline=Read(api);Apps.RemoveAt(1);output["applicationRemoved"]=Counts(Error(()=>Write(api,baseline,Desired(baseline))));
    Reset();api=Api();baseline=Read(api);Predefined=0;baseline=Read(api);output["customShared"]=Counts(Error(()=>Write(api,baseline,Desired(baseline))));
    Reset();api=Api();baseline=Read(api);Global=true;output["global"]=Counts(Error(()=>Write(api,baseline,Desired(baseline))));
    Reset();api=Api();baseline=Read(api);FailEnumeration=true;output["enumerationFailure"]=Counts(Error(()=>Write(api,baseline,Desired(baseline))));
    Reset();api=Api();baseline=Read(api);var missingScope=Clone(baseline);missingScope.profile.scope=null;output["oldUnscoped"]=Counts(Error(()=>Write(api,missingScope,Desired(baseline))));
    Reset();api=Api();baseline=Read(api);var changedTarget=Desired(baseline);changedTarget.profile.scope.fingerprint=new string('0',64);output["targetScopeChange"]=Counts(Error(()=>Write(api,baseline,changedTarget)));
    Reset();api=Api();baseline=Read(api);var deleted=Clone(baseline);deleted.profile=null;output["deleteOfficial"]=Counts(Error(()=>Write(api,baseline,deleted)));
    Reset();api=Api();baseline=Read(api);output["unlistedKey"]=Counts(Error(()=>Write(api,baseline,baseline,new uint[]{0xDEADBEEF})));
    Reset();api=Api();baseline=Read(api);DriftAfterSave=true;output["readbackScopeChange"]=Counts(Error(()=>Write(api,baseline,Desired(baseline))));
    var exclusive=new ZhuangjizhaiNvapiProfile.ProfileState{name="old",appName=Exe,exclusive=true,owned=true};output["exclusiveJson"]=Json().Serialize(exclusive);output["exclusiveRoundtrip"]=Json().Serialize(Clone(exclusive));
    return Json().Serialize(output);
  }
}`;
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${source}\n${harness}\n'@ -Language CSharp -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -ErrorAction Stop\n[SharedProfileProbe]::Run()`;
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '$source=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($source))'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const result = JSON.parse(output.trim());
  assert.equal(result.roundtrip.exact, true); assert.equal(result.roundtrip.rulesUnchanged, true); assert.equal(result.roundtrip.untouchedValue, 42);
  assert.equal(result.roundtrip.sets, 8); assert.equal(result.roundtrip.deletes, 8); assert.equal(result.roundtrip.saves, 2); assert.equal(result.roundtrip.profileMutations, 0);
  assert.equal(result.roundtrip.profile.scope.predefined, true); assert.match(result.roundtrip.profile.scope.fingerprint, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.inspection, { name: 'Official shared game', applications: ['example/game.exe', 'example/game_dx11.exe'], predefined: true, shared: true });
  assert.equal(result.orderIndependent, true); assert.equal(result.reorderedWrite, null);
  const rejected = { ...result.ruleChanges, applicationAdded: result.applicationAdded, applicationRemoved: result.applicationRemoved, customShared: result.customShared, global: result.global,
    enumerationFailure: result.enumerationFailure, oldUnscoped: result.oldUnscoped, targetScopeChange: result.targetScopeChange,
    deleteOfficial: result.deleteOfficial, unlistedKey: result.unlistedKey };
  const codes = { customShared: 'UNSAFE_PROFILE', global: 'UNSAFE_PROFILE', enumerationFailure: 'NVAPI_FAILURE',
    targetScopeChange: 'INVALID_PROFILE_TARGET', deleteOfficial: 'PROFILE_NOT_OWNED', unlistedKey: 'UNSUPPORTED_SETTING' };
  for (const [name, row] of Object.entries(rejected)) {
    assert.equal(row.code, codes[name] || 'NVAPI_CAS_MISMATCH', name);
    assert.equal(row.sets + row.deletes + row.saves + row.profileMutations, 0, `${name} must fail before any mutation`);
  }
  assert.equal(result.readbackScopeChange.code, 'NVAPI_READBACK_MISMATCH'); assert.equal(result.readbackScopeChange.profileMutations, 0);
  assert.equal(result.exclusiveJson, result.exclusiveRoundtrip); assert.equal(Object.hasOwn(JSON.parse(result.exclusiveJson), 'scope'), false);
});
