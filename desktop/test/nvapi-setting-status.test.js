'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Exercise the production C# ReadState/ReadSetting and delete wrappers using
// injected native delegates. No NvAPI library, profile or driver is opened.
function nativeCases() {
  const sources = ['nvapi-drs.ps1', 'nvapi-profile.ps1'].map(name => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'src', 'product', name), 'utf8');
    const match = script.match(/\$source = @'\r?\n([\s\S]*?)\r?\n'@/);
    assert.ok(match, `${name} contains its native source`); return match[1];
  });
  const harness = String.raw`
public static class NvapiSettingStatusProbe {
  static int status, location, calls; static uint value, predefined;
  public static int LegacyGet(System.IntPtr session, System.IntPtr profile, uint id, ref XiaofengNvapi.NVDRS_SETTING setting) {
    calls++; setting.settingLocation=location; setting.isCurrentPredefined=predefined; setting.currentValue.u32Value=value; return status;
  }
  public static int ProfileGet(System.IntPtr session, System.IntPtr profile, uint id, ref ZhuangjizhaiNvapiProfile.NVDRS_SETTING setting) {
    calls++; setting.settingLocation=location; setting.isCurrentPredefined=predefined; setting.currentValue.u32Value=value; return status;
  }
  public static int Delete(System.IntPtr session, System.IntPtr profile, uint id) { calls++; return status; }
  static object RunCase(string helper, string op, int code, int from, uint current, uint isPredefined) {
    status=code; location=from; value=current; predefined=isPredefined; calls=0;
    System.Type owner=helper=="legacy"?typeof(XiaofengNvapi.Drs):typeof(ZhuangjizhaiNvapiProfile.Bridge);
    System.Type apiType=owner.GetNestedType("Api",System.Reflection.BindingFlags.NonPublic);
    // Bypass the profile Api constructor: it would otherwise load real NVAPI.
    object api=System.Runtime.Serialization.FormatterServices.GetUninitializedObject(apiType);
    System.Reflection.FieldInfo field=apiType.GetField(op=="read"?"GetSetting":"DeleteSetting");
    System.Reflection.MethodInfo callback=typeof(NvapiSettingStatusProbe).GetMethod(op=="read"?(helper=="legacy"?"LegacyGet":"ProfileGet"):"Delete");
    field.SetValue(api,System.Delegate.CreateDelegate(field.FieldType,callback));
    string method=op=="read"?(helper=="legacy"?"ReadState":"ReadSetting"):(helper=="legacy"?"DeleteSetting":"Delete");
    object[] args=helper=="legacy"?new object[]{api,System.IntPtr.Zero,System.IntPtr.Zero,(uint)0x10E41E01}
      :op=="read"?new object[]{api,System.IntPtr.Zero,(uint)0x10E41E01,false}:new object[]{api,System.IntPtr.Zero,(uint)0x10E41E01};
    var row=new System.Collections.Generic.Dictionary<string,object>{{"helper",helper},{"op",op},{"status",code},{"location",from},{"value",current},{"predefined",isPredefined}};
    try { row["result"]=owner.GetMethod(method,System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static).Invoke(null,args); }
    catch(System.Reflection.TargetInvocationException error) { row["error"]=error.InnerException.Message; }
    row["nativeCalls"]=calls; return row;
  }
  public static string Run() {
    var rows=new System.Collections.Generic.List<object>();
    foreach(string helper in new[]{"legacy","profile"}) {
      foreach(int code in new[]{-160,-165,-175}) rows.Add(RunCase(helper,"read",code,0,123,0));
      rows.Add(RunCase(helper,"read",0,0,0,0));
      rows.Add(RunCase(helper,"read",0,0,13,1));
      rows.Add(RunCase(helper,"read",0,1,11,0));
      rows.Add(RunCase(helper,"read",0,4,99,0));
      foreach(int code in new[]{0,-160,-165,-175}) rows.Add(RunCase(helper,"delete",code,0,0,0));
    }
    return new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(rows);
  }
}`;
  // Compile the fixture with both helper sources so test code can reference
  // their public ABI structs without depending on Add-Type's dynamic paths.
  const imports = [...new Set(sources.flatMap(source => source.match(/^using [^;]+;/gm)))].join('\n');
  const native = imports + '\n' + sources.map(source => source.replace(/^using [^;]+;\r?\n/gm, '')).join('\n') + '\n' + harness;
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${native}\n'@ -Language CSharp -ReferencedAssemblies @('System.dll','System.Core.dll','System.Web.Extensions.dll') -ErrorAction Stop\n[NvapiSettingStatusProbe]::Run()`;
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const output = execFileSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    '$source=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($source))'], { input: script, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return JSON.parse(output.trim());
}

test('native adapters distinguish missing settings from explicit zero, inheritance and actual failures', { skip: process.platform !== 'win32' }, () => {
  const rows = nativeCases();
  for (const helper of ['legacy', 'profile']) {
    const pick = (status, location = 0, op = 'read') => rows.find(row => row.helper === helper && row.op === op && row.status === status && row.location === location);
    const absent = pick(-160); assert.equal(absent.error, undefined); assert.equal(absent.result.kind, 'absent');
    assert.equal(absent.result.value, null, `${helper}: undefined settings must not manufacture a DWORD zero`);
    assert.equal(absent.result.location, null); assert.equal(absent.result.predefined, null);
    const zero = pick(0); assert.equal(zero.result.kind, 'explicit'); assert.equal(zero.result.value, 0);
    const predefined = rows.find(row => row.helper === helper && row.op === 'read' && row.predefined === 1);
    assert.equal(predefined.result.kind, 'inherited'); assert.equal(predefined.result.value, 13);
    const global = pick(0, 1); assert.equal(global.result.kind, 'inherited'); assert.equal(global.result.value, 11);
    if (helper === 'legacy') {
      assert.equal(absent.result.explicitValue, false); assert.equal(zero.result.explicitValue, true);
      assert.equal(global.result.explicitValue, false, 'a user-set global value is not a per-game override');
    }
    assert.match(pick(0, 4).error, /unknown location/);
    for (const code of [-165, -175]) {
      const failed = pick(code); assert.match(failed.error, new RegExp(`failed \\(${code}\\)`)); assert.equal(failed.result, undefined);
      assert.match(pick(code, 0, 'delete').error, new RegExp(`failed \\(${code}\\)`));
    }
    for (const code of [0, -160]) assert.equal(pick(code, 0, 'delete').error, undefined);
  }
  assert.ok(rows.every(row => row.nativeCalls === 1), 'each result must exercise the injected native boundary once');
});
