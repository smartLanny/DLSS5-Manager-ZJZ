param(
  [ValidateSet('apply','read','restore','selftest')][string]$Action = 'apply',
  [string]$ExePath = '',
  [ValidateSet('K','L','M')][string]$Preset = 'K',
  [string]$FriendlyName = '',
  [ValidateSet('0','1')][string]$EnableExplicit = '0',
  [UInt32]$EnableValue = 0,
  [ValidateSet('0','1')][string]$PresetExplicit = '0',
  [UInt32]$PresetValue = 0
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)

$source = @'
using System;
using System.IO;
using System.Runtime.InteropServices;

namespace XiaofengNvapi {
  public sealed class SettingState {
    public bool explicitValue { get; set; }
    public uint? value { get; set; }
    public string kind { get; set; }
    public int? location { get; set; }
    public bool? predefined { get; set; }
    public SettingState() { kind = "absent"; }
  }

  public sealed class StateResult {
    public bool ok { get; set; }
    public bool profileFound { get; set; }
    public string profile { get; set; }
    public SettingState enable { get; set; }
    public SettingState preset { get; set; }
    public string error { get; set; }
  }

  public sealed class ApplyResult {
    public bool ok { get; set; }
    public string profile { get; set; }
    public bool created { get; set; }
    public string preset { get; set; }
    public uint rawPreset { get; set; }
    public bool restored { get; set; }
    public string error { get; set; }
  }

  [StructLayout(LayoutKind.Explicit, Size = 4100)]
  public struct NVDRS_VALUE {
    [FieldOffset(0)] public uint u32Value;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NVDRS_SETTING {
    public uint version;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string settingName;
    public uint settingId;
    public int settingType;
    public int settingLocation;
    public uint isCurrentPredefined;
    public uint isPredefinedValid;
    public NVDRS_VALUE predefinedValue;
    public NVDRS_VALUE currentValue;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NVDRS_PROFILE {
    public uint version;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string profileName;
    public uint gpuSupport;
    public uint isPredefined;
    public uint numOfApps;
    public uint numOfSettings;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct NVDRS_APPLICATION {
    public uint version;
    public uint isPredefined;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string appName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string userFriendlyName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string launcher;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string fileInFolder;
    public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 2048)] public string commandLine;
  }

  public static class Drs {
    const int OK = 0;
    const int PROFILE_NOT_FOUND = -163;
    // NVIDIA nvapi_lite_common.h: -160 is SETTING_NOT_FOUND;
    // -165 is PROFILE_NAME_EMPTY and must remain a failure.
    // https://github.com/NVIDIA/nvapi/blob/main/nvapi_lite_common.h
    const int SETTING_NOT_FOUND = -160;
    const int EXECUTABLE_NOT_FOUND = -166;

    const uint SR_OVERRIDE_ID = 0x10E41E01;
    const uint SR_PRESET_ID = 0x10E41DF3;

    const uint ID_INITIALIZE = 0x0150E828;
    const uint ID_UNLOAD = 0xD22BDD7E;
    const uint ID_DRS_CREATE_SESSION = 0x0694D52E;
    const uint ID_DRS_DESTROY_SESSION = 0xDAD9CFF8;
    const uint ID_DRS_LOAD_SETTINGS = 0x375DBD6B;
    const uint ID_DRS_SAVE_SETTINGS = 0xFCBC7E14;
    const uint ID_DRS_SET_SETTING = 0x577DD202;
    const uint ID_DRS_GET_SETTING = 0x73BF8338;
    const uint ID_DRS_DELETE_PROFILE_SETTING = 0xE4A26362;
    const uint ID_DRS_CREATE_PROFILE = 0xCC176068;
    const uint ID_DRS_FIND_PROFILE_BY_NAME = 0x7E4A9A0B;
    const uint ID_DRS_GET_PROFILE_INFO = 0x61CD6FD6;
    const uint ID_DRS_CREATE_APPLICATION = 0x4347A9DE;
    const uint ID_DRS_FIND_APPLICATION_BY_NAME = 0xEEE566B2;

    [DllImport("nvapi64.dll", CallingConvention = CallingConvention.Cdecl)]
    static extern IntPtr nvapi_QueryInterface(uint id);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SimpleFn();
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SessionCreateFn(out IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SessionFn(IntPtr session);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int SetSettingFn(IntPtr session, IntPtr profile, ref NVDRS_SETTING setting);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int GetSettingFn(IntPtr session, IntPtr profile, uint settingId, ref NVDRS_SETTING setting);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int DeleteSettingFn(IntPtr session, IntPtr profile, uint settingId);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CreateProfileFn(IntPtr session, ref NVDRS_PROFILE profile, out IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FindProfileFn(IntPtr session, [MarshalAs(UnmanagedType.LPWStr)] string profileName, out IntPtr handle);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int GetProfileInfoFn(IntPtr session, IntPtr profile, ref NVDRS_PROFILE info);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int CreateApplicationFn(IntPtr session, IntPtr profile, ref NVDRS_APPLICATION app);
    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate int FindApplicationFn(IntPtr session, [MarshalAs(UnmanagedType.LPWStr)] string appName, out IntPtr profile, ref NVDRS_APPLICATION app);

    sealed class Api {
      public SimpleFn Initialize, Unload;
      public SessionCreateFn CreateSession;
      public SessionFn DestroySession, LoadSettings, SaveSettings;
      public SetSettingFn SetSetting;
      public GetSettingFn GetSetting;
      public DeleteSettingFn DeleteSetting;
      public CreateProfileFn CreateProfile;
      public FindProfileFn FindProfile;
      public GetProfileInfoFn GetProfileInfo;
      public CreateApplicationFn CreateApplication;
      public FindApplicationFn FindApplication;
    }

    static T Resolve<T>(uint id) where T : class {
      IntPtr address = nvapi_QueryInterface(id);
      if (address == IntPtr.Zero) throw new InvalidOperationException(String.Format("NvAPI interface 0x{0:X8} unavailable", id));
      return Marshal.GetDelegateForFunctionPointer(address, typeof(T)) as T;
    }

    static Api LoadApi() {
      return new Api {
        Initialize = Resolve<SimpleFn>(ID_INITIALIZE),
        Unload = Resolve<SimpleFn>(ID_UNLOAD),
        CreateSession = Resolve<SessionCreateFn>(ID_DRS_CREATE_SESSION),
        DestroySession = Resolve<SessionFn>(ID_DRS_DESTROY_SESSION),
        LoadSettings = Resolve<SessionFn>(ID_DRS_LOAD_SETTINGS),
        SaveSettings = Resolve<SessionFn>(ID_DRS_SAVE_SETTINGS),
        SetSetting = Resolve<SetSettingFn>(ID_DRS_SET_SETTING),
        GetSetting = Resolve<GetSettingFn>(ID_DRS_GET_SETTING),
        DeleteSetting = Resolve<DeleteSettingFn>(ID_DRS_DELETE_PROFILE_SETTING),
        CreateProfile = Resolve<CreateProfileFn>(ID_DRS_CREATE_PROFILE),
        FindProfile = Resolve<FindProfileFn>(ID_DRS_FIND_PROFILE_BY_NAME),
        GetProfileInfo = Resolve<GetProfileInfoFn>(ID_DRS_GET_PROFILE_INFO),
        CreateApplication = Resolve<CreateApplicationFn>(ID_DRS_CREATE_APPLICATION),
        FindApplication = Resolve<FindApplicationFn>(ID_DRS_FIND_APPLICATION_BY_NAME)
      };
    }

    static uint Ver(Type type, int version) { return ((uint)Marshal.SizeOf(type)) | ((uint)version << 16); }

    static NVDRS_SETTING NewSetting() {
      NVDRS_SETTING value = new NVDRS_SETTING();
      value.version = Ver(typeof(NVDRS_SETTING), 1);
      value.settingName = String.Empty;
      return value;
    }

    static NVDRS_PROFILE NewProfile() {
      NVDRS_PROFILE value = new NVDRS_PROFILE();
      value.version = Ver(typeof(NVDRS_PROFILE), 1);
      value.profileName = String.Empty;
      return value;
    }

    static NVDRS_APPLICATION NewApplication() {
      NVDRS_APPLICATION value = new NVDRS_APPLICATION();
      value.version = Ver(typeof(NVDRS_APPLICATION), 4);
      value.appName = String.Empty;
      value.userFriendlyName = String.Empty;
      value.launcher = String.Empty;
      value.fileInFolder = String.Empty;
      value.commandLine = String.Empty;
      return value;
    }

    static void Check(int status, string operation) {
      if (status != OK) throw new InvalidOperationException(String.Format("{0} failed ({1})", operation, status));
    }

    static void SetDword(Api api, IntPtr session, IntPtr profile, uint id, uint value) {
      NVDRS_SETTING setting = NewSetting();
      setting.settingId = id;
      setting.settingType = 0;
      setting.currentValue.u32Value = value;
      Check(api.SetSetting(session, profile, ref setting), String.Format("NvAPI_DRS_SetSetting 0x{0:X8}", id));
    }

    static void DeleteSetting(Api api, IntPtr session, IntPtr profile, uint id) {
      int status = api.DeleteSetting(session, profile, id);
      CheckDeleteStatus(status, id);
    }

    static void CheckDeleteStatus(int status, uint id) {
      if (status != OK && status != SETTING_NOT_FOUND)
        throw new InvalidOperationException(String.Format("NvAPI_DRS_DeleteProfileSetting 0x{0:X8} failed ({1})", id, status));
    }

    static SettingState ReadState(Api api, IntPtr session, IntPtr profile, uint id) {
      NVDRS_SETTING setting = NewSetting();
      int status = api.GetSetting(session, profile, id, ref setting);
      return DecodeReadState(status, setting, id);
    }

    static SettingState DecodeReadState(int status, NVDRS_SETTING setting, uint id) {
      if (status == SETTING_NOT_FOUND) return new SettingState();
      Check(status, String.Format("NvAPI_DRS_GetSetting 0x{0:X8}", id));
      if (setting.settingType != 0) throw new InvalidOperationException(String.Format("NvAPI setting 0x{0:X8} is not a DWORD", id));
      if (setting.settingLocation < 0 || setting.settingLocation > 3)
        throw new InvalidOperationException(String.Format("NvAPI setting 0x{0:X8} has unknown location {1}", id, setting.settingLocation));
      SettingState state = new SettingState();
      state.explicitValue = setting.settingLocation == 0 && setting.isCurrentPredefined == 0;
      state.kind = state.explicitValue ? "explicit" : "inherited";
      state.value = setting.currentValue.u32Value;
      state.location = setting.settingLocation;
      state.predefined = setting.isCurrentPredefined != 0;
      return state;
    }

    static IntPtr ResolveProfile(Api api, IntPtr session, string exePath, bool create, string friendlyName,
      out string profileName, out bool created) {
      profileName = String.Empty;
      created = false;
      string full = Path.GetFullPath(exePath);
      NVDRS_APPLICATION foundApp = NewApplication();
      IntPtr profile;
      int status = api.FindApplication(session, full, out profile, ref foundApp);
      if (status == OK) {
        NVDRS_PROFILE info = NewProfile();
        if (api.GetProfileInfo(session, profile, ref info) == OK) profileName = info.profileName ?? String.Empty;
        return profile;
      }
      if (status != EXECUTABLE_NOT_FOUND && status != PROFILE_NOT_FOUND)
        throw new InvalidOperationException(String.Format("NvAPI_DRS_FindApplicationByName failed ({0})", status));
      if (!create) return IntPtr.Zero;

      string exeName = Path.GetFileName(full);
      string requestedName = String.IsNullOrWhiteSpace(friendlyName) ? ("Xiaofeng DLSS5 - " + exeName) : friendlyName.Trim();
      if (requestedName.Length > 160) requestedName = requestedName.Substring(0, 160);
      status = api.FindProfile(session, requestedName, out profile);
      if (status == PROFILE_NOT_FOUND) {
        NVDRS_PROFILE newProfile = NewProfile();
        newProfile.profileName = requestedName;
        newProfile.gpuSupport = 1;
        Check(api.CreateProfile(session, ref newProfile, out profile), "NvAPI_DRS_CreateProfile");
        created = true;
      } else if (status != OK) {
        throw new InvalidOperationException(String.Format("NvAPI_DRS_FindProfileByName failed ({0})", status));
      }

      NVDRS_APPLICATION app = NewApplication();
      app.appName = exeName;
      app.userFriendlyName = requestedName;
      Check(api.CreateApplication(session, profile, ref app), "NvAPI_DRS_CreateApplication");
      profileName = requestedName;
      return profile;
    }

    static uint PresetValue(string preset) {
      string value = (preset ?? String.Empty).Trim().ToUpperInvariant();
      if (value == "K") return 11;
      if (value == "L") return 12;
      if (value == "M") return 13;
      throw new ArgumentException("Unsupported SR preset: " + preset);
    }

    static bool ValidExe(string exePath) {
      return !String.IsNullOrWhiteSpace(exePath) && Path.IsPathRooted(exePath) &&
        String.Equals(Path.GetExtension(exePath), ".exe", StringComparison.OrdinalIgnoreCase);
    }

    public static string LayoutSummary() {
      int setting = Marshal.SizeOf(typeof(NVDRS_SETTING));
      int profile = Marshal.SizeOf(typeof(NVDRS_PROFILE));
      int application = Marshal.SizeOf(typeof(NVDRS_APPLICATION));
      if (setting != 12320 || profile != 4116 || application != 20492)
        throw new InvalidOperationException(String.Format("Unexpected NvAPI struct layout {0}/{1}/{2}", setting, profile, application));
      return String.Format("NVDRS_SETTING={0};NVDRS_PROFILE={1};NVDRS_APPLICATION_V4={2}", setting, profile, application);
    }

    public static StateResult Read(string exePath) {
      StateResult result = new StateResult { profile = String.Empty, error = String.Empty,
        enable = new SettingState(), preset = new SettingState() };
      if (!ValidExe(exePath)) { result.error = "Invalid game executable path"; return result; }
      Api api = null; IntPtr session = IntPtr.Zero; bool initialized = false;
      try {
        api = LoadApi(); Check(api.Initialize(), "NvAPI_Initialize"); initialized = true;
        Check(api.CreateSession(out session), "NvAPI_DRS_CreateSession"); Check(api.LoadSettings(session), "NvAPI_DRS_LoadSettings");
        string profileName; bool created;
        IntPtr profile = ResolveProfile(api, session, exePath, false, String.Empty, out profileName, out created);
        result.profile = profileName;
        result.profileFound = profile != IntPtr.Zero;
        if (profile != IntPtr.Zero) {
          result.enable = ReadState(api, session, profile, SR_OVERRIDE_ID);
          result.preset = ReadState(api, session, profile, SR_PRESET_ID);
        }
        result.ok = true;
        return result;
      } catch (Exception ex) { result.error = ex.Message; return result; }
      finally { Close(api, session, initialized); }
    }

    public static ApplyResult Apply(string exePath, string preset, string friendlyName) {
      ApplyResult result = new ApplyResult { preset = preset ?? String.Empty, error = String.Empty };
      if (!ValidExe(exePath)) { result.error = "Invalid game executable path"; return result; }
      Api api = null; IntPtr session = IntPtr.Zero; bool initialized = false;
      try {
        api = LoadApi(); Check(api.Initialize(), "NvAPI_Initialize"); initialized = true;
        Check(api.CreateSession(out session), "NvAPI_DRS_CreateSession"); Check(api.LoadSettings(session), "NvAPI_DRS_LoadSettings");
        string profileName; bool created;
        IntPtr profile = ResolveProfile(api, session, exePath, true, friendlyName, out profileName, out created);
        uint raw = PresetValue(preset);
        SetDword(api, session, profile, SR_OVERRIDE_ID, 1); SetDword(api, session, profile, SR_PRESET_ID, raw);
        Check(api.SaveSettings(session), "NvAPI_DRS_SaveSettings");
        SettingState verifyEnable = ReadState(api, session, profile, SR_OVERRIDE_ID);
        SettingState verifyPreset = ReadState(api, session, profile, SR_PRESET_ID);
        if (!verifyEnable.explicitValue || verifyEnable.value != 1 || !verifyPreset.explicitValue || verifyPreset.value != raw)
          throw new InvalidOperationException("NvAPI SR override read-back mismatch");
        result.ok = true; result.profile = profileName; result.created = created; result.rawPreset = raw;
        return result;
      } catch (Exception ex) { result.error = ex.Message; return result; }
      finally { Close(api, session, initialized); }
    }

    public static ApplyResult Restore(string exePath, bool enableExplicit, uint enableValue,
      bool presetExplicit, uint presetValue) {
      ApplyResult result = new ApplyResult { preset = "baseline", error = String.Empty };
      if (!ValidExe(exePath)) { result.error = "Invalid game executable path"; return result; }
      Api api = null; IntPtr session = IntPtr.Zero; bool initialized = false;
      try {
        api = LoadApi(); Check(api.Initialize(), "NvAPI_Initialize"); initialized = true;
        Check(api.CreateSession(out session), "NvAPI_DRS_CreateSession"); Check(api.LoadSettings(session), "NvAPI_DRS_LoadSettings");
        string profileName; bool created;
        IntPtr profile = ResolveProfile(api, session, exePath, false, String.Empty, out profileName, out created);
        if (profile == IntPtr.Zero) {
          if (enableExplicit || presetExplicit) throw new InvalidOperationException("Original NVIDIA profile disappeared; refusing to guess restoration target");
          result.ok = true; result.restored = true; return result;
        }
        if (enableExplicit) SetDword(api, session, profile, SR_OVERRIDE_ID, enableValue); else DeleteSetting(api, session, profile, SR_OVERRIDE_ID);
        if (presetExplicit) SetDword(api, session, profile, SR_PRESET_ID, presetValue); else DeleteSetting(api, session, profile, SR_PRESET_ID);
        Check(api.SaveSettings(session), "NvAPI_DRS_SaveSettings");
        if (enableExplicit) { SettingState verify = ReadState(api, session, profile, SR_OVERRIDE_ID); if (!verify.explicitValue || verify.value != enableValue) throw new InvalidOperationException("NvAPI SR enable restoration read-back mismatch"); }
        if (presetExplicit) { SettingState verify = ReadState(api, session, profile, SR_PRESET_ID); if (!verify.explicitValue || verify.value != presetValue) throw new InvalidOperationException("NvAPI SR preset restoration read-back mismatch"); }
        result.ok = true; result.restored = true; result.profile = profileName;
        return result;
      } catch (Exception ex) { result.error = ex.Message; return result; }
      finally { Close(api, session, initialized); }
    }

    static void Close(Api api, IntPtr session, bool initialized) {
      if (api == null) return;
      if (session != IntPtr.Zero) { try { api.DestroySession(session); } catch { } }
      if (initialized) { try { api.Unload(); } catch { } }
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp -ErrorAction Stop
  if ($Action -eq 'selftest') {
    $layout = [XiaofengNvapi.Drs]::LayoutSummary()
    [pscustomobject]@{ ok = $true; layout = $layout } | ConvertTo-Json -Compress
    exit 0
  }
  if ($Action -eq 'read') {
    $result = [XiaofengNvapi.Drs]::Read($ExePath)
  } elseif ($Action -eq 'restore') {
    $result = [XiaofengNvapi.Drs]::Restore($ExePath, $EnableExplicit -eq '1', $EnableValue, $PresetExplicit -eq '1', $PresetValue)
  } else {
    $result = [XiaofengNvapi.Drs]::Apply($ExePath, $Preset, $FriendlyName)
  }
  # Convert the C# explicitValue property to the JS-facing name `explicit`.
  if ($Action -eq 'read' -and $result.ok) {
    [pscustomobject]@{
      ok = $true
      profileFound = $result.profileFound
      profile = $result.profile
      enable = [pscustomobject]@{ explicit = $result.enable.explicitValue; value = $result.enable.value; kind = $result.enable.kind; location = $result.enable.location; predefined = $result.enable.predefined }
      preset = [pscustomobject]@{ explicit = $result.preset.explicitValue; value = $result.preset.value; kind = $result.preset.kind; location = $result.preset.location; predefined = $result.preset.predefined }
    } | ConvertTo-Json -Compress
  } else {
    $result | ConvertTo-Json -Compress
  }
  if ($result.ok) { exit 0 }
  exit 2
} catch {
  [pscustomobject]@{ ok = $false; error = $_.Exception.Message; code = 'NVAPI_HELPER_EXCEPTION' } | ConvertTo-Json -Compress
  exit 1
}
