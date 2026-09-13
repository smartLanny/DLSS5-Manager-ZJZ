$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-Result([bool]$Ok, $Result, [string]$Code, [string]$Message) {
  [Console]::Out.WriteLine((@{ version = 1; ok = $Ok; result = $Result; code = $Code; error = $Message } | ConvertTo-Json -Compress -Depth 8))
}
function Fail([string]$Code, [string]$Message) {
  $exception = New-Object System.Exception($Message)
  $exception.Data['Code'] = $Code
  throw $exception
}

$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

public static class XiaofengGameLaunchBroker {
  const UInt32 PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const UInt32 TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008;
  const UInt32 MAXIMUM_ALLOWED = 0x02000000;
  const UInt32 CREATE_SUSPENDED = 0x00000004, CREATE_UNICODE_ENVIRONMENT = 0x00000400;
  const UInt32 LOGON_WITH_PROFILE = 0x00000001;
  const UInt32 STARTF_USESHOWWINDOW = 0x00000001;
  const short SW_SHOWNORMAL = 1;
  const int SecurityImpersonation = 2, TokenPrimary = 1;
  const int TokenUser = 1, TokenSessionId = 12, TokenElevation = 20;

  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO {
    public UInt32 cb; public string lpReserved, lpDesktop, lpTitle; public UInt32 dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public UInt32 dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_ELEVATION { public int TokenIsElevated; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_USER { public SID_AND_ATTRIBUTES User; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public UInt32 Attributes; }

  [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] static extern UInt32 GetWindowThreadProcessId(IntPtr hWnd, out UInt32 processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(UInt32 access, bool inherit, UInt32 processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(UInt32 processId, out UInt32 sessionId);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, UInt32 access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr existing, UInt32 access, IntPtr attributes, int impersonation, int tokenType, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessWithTokenW(IntPtr token, UInt32 logonFlags, string applicationName,
    StringBuilder commandLine, UInt32 creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string applicationName, StringBuilder commandLine,
    IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, UInt32 creationFlags, IntPtr environment,
    string currentDirectory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int informationClass, IntPtr information, int length, out int returnLength);
  [DllImport("advapi32.dll")] static extern bool IsValidSid(IntPtr sid);
  [DllImport("advapi32.dll")] static extern UInt32 GetLengthSid(IntPtr sid);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
  [DllImport("userenv.dll", SetLastError=true)] static extern bool DestroyEnvironmentBlock(IntPtr environment);
  [DllImport("kernel32.dll", SetLastError=true)] static extern UInt32 ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, UInt32 exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);

  sealed class Handles : IDisposable {
    public IntPtr ShellProcess, ShellToken, PrimaryToken, CurrentToken;
    public UInt32 ShellPid, SessionId; public string Sid; public bool Elevated, BrokerElevated;
    public void Dispose() { if (CurrentToken != IntPtr.Zero) CloseHandle(CurrentToken); if (PrimaryToken != IntPtr.Zero) CloseHandle(PrimaryToken); if (ShellToken != IntPtr.Zero) CloseHandle(ShellToken); if (ShellProcess != IntPtr.Zero) CloseHandle(ShellProcess); }
  }
  static Exception Error(string code, string message) { return new Exception(code + "|" + message); }
  static void Win32(bool ok, string code, string message) { if (!ok) throw Error(code, message + " (Win32 " + Marshal.GetLastWin32Error() + ")"); }
  static T TokenInfo<T>(IntPtr token, int kind) where T : struct {
    int needed; GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
    if (needed <= 0 || needed > 65536) throw Error("GAME_LAUNCH_TOKEN_QUERY", "Token information size is invalid.");
    IntPtr buffer = Marshal.AllocHGlobal(needed);
    try { Win32(GetTokenInformation(token, kind, buffer, needed, out needed), "GAME_LAUNCH_TOKEN_QUERY", "Cannot read process token."); return (T)Marshal.PtrToStructure(buffer, typeof(T)); }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  static string Sid(IntPtr token) {
    int needed; GetTokenInformation(token, TokenUser, IntPtr.Zero, 0, out needed);
    if (needed < Marshal.SizeOf(typeof(TOKEN_USER)) || needed > 65536) throw Error("GAME_LAUNCH_TOKEN_QUERY", "Token user size is invalid.");
    int capacity = needed; IntPtr buffer = Marshal.AllocHGlobal(capacity);
    try {
      Win32(GetTokenInformation(token, TokenUser, buffer, capacity, out needed), "GAME_LAUNCH_TOKEN_QUERY", "Cannot read token user.");
      var user = (TOKEN_USER)Marshal.PtrToStructure(buffer, typeof(TOKEN_USER));
      long offset = user.User.Sid.ToInt64() - buffer.ToInt64();
      if (offset < 0 || offset + 8 > capacity || !IsValidSid(user.User.Sid)) throw Error("GAME_LAUNCH_TOKEN_QUERY", "Token SID is invalid.");
      uint length = GetLengthSid(user.User.Sid);
      if (length < 8 || length > 68 || offset + length > capacity) throw Error("GAME_LAUNCH_TOKEN_QUERY", "Token SID exceeds its buffer.");
      // SecurityIdentifier copies the binary SID while TOKEN_USER still owns its memory.
      return new SecurityIdentifier(user.User.Sid).Value;
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  static UInt32 Session(IntPtr token) { return TokenInfo<UInt32>(token, TokenSessionId); }
  static bool Elevated(IntPtr token) { return TokenInfo<TOKEN_ELEVATION>(token, TokenElevation).TokenIsElevated != 0; }
  static Handles ShellToken() {
    IntPtr window = GetShellWindow(); if (window == IntPtr.Zero) throw Error("GAME_LAUNCH_SHELL_MISSING", "Interactive desktop shell is unavailable.");
    UInt32 pid; if (GetWindowThreadProcessId(window, out pid) == 0 || pid == 0) throw Error("GAME_LAUNCH_SHELL_MISSING", "Cannot identify the interactive desktop shell.");
    var h = new Handles(); h.ShellPid = pid;
    try {
      Win32(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE, out h.CurrentToken), "GAME_LAUNCH_TOKEN_QUERY", "Cannot read the Manager token.");
      h.BrokerElevated = Elevated(h.CurrentToken);
      h.ShellProcess = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid); if (h.ShellProcess == IntPtr.Zero) throw Error("GAME_LAUNCH_SHELL_TOKEN", "Cannot open the desktop shell process.");
      UInt32 shellAccess = TOKEN_QUERY | (h.BrokerElevated ? TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY : 0);
      Win32(OpenProcessToken(h.ShellProcess, shellAccess, out h.ShellToken), "GAME_LAUNCH_SHELL_TOKEN", "Cannot open the desktop shell token.");
      h.Sid = Sid(h.ShellToken); h.SessionId = Session(h.ShellToken); h.Elevated = Elevated(h.ShellToken);
      UInt32 processSession; Win32(ProcessIdToSessionId(pid, out processSession), "GAME_LAUNCH_SESSION_MISMATCH", "Cannot read the desktop shell session.");
      if (processSession != h.SessionId) throw Error("GAME_LAUNCH_SESSION_MISMATCH", "Desktop shell process and token sessions differ.");
      if (!String.Equals(Sid(h.CurrentToken), h.Sid, StringComparison.OrdinalIgnoreCase) || Session(h.CurrentToken) != h.SessionId)
        throw Error("GAME_LAUNCH_SESSION_MISMATCH", "Manager and desktop shell do not belong to the same user and session.");
      if (h.Elevated) throw Error("GAME_LAUNCH_SHELL_ELEVATED", "Desktop shell token is elevated; Vulkan user layers would remain unavailable.");
      if (h.BrokerElevated)
        Win32(DuplicateTokenEx(h.ShellToken, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityImpersonation, TokenPrimary, out h.PrimaryToken), "GAME_LAUNCH_SHELL_TOKEN", "Cannot duplicate the desktop shell primary token.");
      return h;
    } catch { h.Dispose(); throw; }
  }
  static Dictionary<string,string> ReadEnvironment(IntPtr block) {
    var values = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase); long offset = 0;
    while (true) {
      IntPtr item = new IntPtr(block.ToInt64() + offset); string row = Marshal.PtrToStringUni(item);
      if (String.IsNullOrEmpty(row)) break;
      int split = row.IndexOf('=', row[0] == '=' ? 1 : 0); if (split > 0) values[row.Substring(0, split)] = row.Substring(split + 1);
      offset += (row.Length + 1) * 2L;
    }
    return values;
  }
  static IntPtr Environment(IntPtr token, IDictionary<string,string> overrides, out IntPtr source) {
    Win32(CreateEnvironmentBlock(out source, token, false), "GAME_LAUNCH_ENVIRONMENT", "Cannot create the interactive user environment.");
    var values = ReadEnvironment(source); foreach (var pair in overrides) values[pair.Key] = pair.Value;
    string block = String.Join("\0", values.OrderBy(pair => pair.Key, StringComparer.OrdinalIgnoreCase).Select(pair => pair.Key + "=" + pair.Value)) + "\0\0";
    if (block.Length > 32767) throw Error("GAME_LAUNCH_ENVIRONMENT", "Interactive user environment exceeds the Windows process limit.");
    return Marshal.StringToHGlobalUni(block);
  }
  static string Quote(string value) {
    if (value.Length > 0 && value.IndexOfAny(new [] {' ', '\t', '\n', '\v', '"'}) < 0) return value;
    var output = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); slashes = 0; continue; }
      output.Append('\\', slashes); slashes = 0; output.Append(c);
    }
    output.Append('\\', slashes * 2); output.Append('"'); return output.ToString();
  }
  static IDictionary<string,object> Public(Handles shell) { return new Dictionary<string,object> { {"launchable", true}, {"elevated", false}, {"userSid", shell.Sid}, {"sessionId", (int)shell.SessionId}, {"shellPid", (int)shell.ShellPid}, {"launchMethod", shell.BrokerElevated ? "shell-token" : "current-token"} }; }
  public static IDictionary<string,object> Inspect() { using (var shell = ShellToken()) return Public(shell); }
  public static IDictionary<string,object> Launch(string exe, string[] args, IDictionary<string,string> environment, string cwd, string expectedSid, UInt32 expectedSession, UInt32 expectedShellPid) {
    using (var shell = ShellToken()) {
      if (!String.Equals(shell.Sid, expectedSid, StringComparison.OrdinalIgnoreCase) || shell.SessionId != expectedSession || shell.ShellPid != expectedShellPid)
        throw Error("GAME_LAUNCH_SHELL_CHANGED", "Desktop shell identity changed after inspection; retry the launch.");
      IntPtr source = IntPtr.Zero, custom = IntPtr.Zero; PROCESS_INFORMATION process = new PROCESS_INFORMATION(); bool created = false, resumed = false;
      try {
        custom = Environment(shell.BrokerElevated ? shell.PrimaryToken : shell.CurrentToken, environment, out source);
        string command = Quote(exe) + (args.Length == 0 ? "" : " " + String.Join(" ", args.Select(Quote)));
        if (command.Length > 32766) throw Error("GAME_LAUNCH_REQUEST_INVALID", "Game command line exceeds the Windows process limit.");
        var startup = new STARTUPINFO { cb = (UInt32)Marshal.SizeOf(typeof(STARTUPINFO)), lpDesktop = "winsta0\\default", dwFlags = STARTF_USESHOWWINDOW, wShowWindow = SW_SHOWNORMAL };
        // Ordinary callers already have the verified user's non-elevated token.
        // Elevated callers retain the explicit shell-token privilege transition.
        // Both paths keep the child suspended until its actual token is checked.
        bool launched = shell.BrokerElevated
          ? CreateProcessWithTokenW(shell.PrimaryToken, LOGON_WITH_PROFILE, exe, new StringBuilder(command), CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
              custom, cwd, ref startup, out process)
          : CreateProcessW(exe, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
              custom, cwd, ref startup, out process);
        Win32(launched, "GAME_LAUNCH_CREATE_FAILED", "Cannot create the game with the verified non-elevated user token.");
        created = true; IntPtr childToken;
        Win32(OpenProcessToken(process.hProcess, TOKEN_QUERY, out childToken), "GAME_LAUNCH_TOKEN_QUERY", "Cannot verify the suspended game token.");
        try {
          if (Elevated(childToken) || !String.Equals(Sid(childToken), shell.Sid, StringComparison.OrdinalIgnoreCase) || Session(childToken) != shell.SessionId)
            throw Error("GAME_LAUNCH_TOKEN_MISMATCH", "Suspended game token does not match the interactive non-elevated shell token.");
        } finally { CloseHandle(childToken); }
        if (ResumeThread(process.hThread) == 0xffffffff) throw Error("GAME_LAUNCH_RESUME_FAILED", "Cannot resume the verified game process.");
        resumed = true; var result = Public(shell); result["pid"] = (int)process.dwProcessId; return result;
      } finally {
        if (created && !resumed && process.hProcess != IntPtr.Zero) { TerminateProcess(process.hProcess, 0xE0000001); WaitForSingleObject(process.hProcess, 5000); }
        if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread); if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
        if (custom != IntPtr.Zero) Marshal.FreeHGlobal(custom); if (source != IntPtr.Zero) DestroyEnvironmentBlock(source);
      }
    }
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
  try { $request = ([Console]::In.ReadToEnd() | ConvertFrom-Json) } catch { Fail 'GAME_LAUNCH_REQUEST_INVALID' 'Request JSON is invalid.' }
  if ($null -eq $request -or [int]$request.version -ne 1 -or [string]::IsNullOrWhiteSpace([string]$request.exe)) { Fail 'GAME_LAUNCH_REQUEST_INVALID' 'Request structure is invalid.' }
  if ([string]$request.op -ceq 'inspect') {
    Send-Result $true ([XiaofengGameLaunchBroker]::Inspect()) $null $null
  } elseif ([string]$request.op -ceq 'launch') {
    if ($null -eq $request.expected -or [string]::IsNullOrWhiteSpace([string]$request.cwd)) { Fail 'GAME_LAUNCH_REQUEST_INVALID' 'Launch identity or working directory is missing.' }
    $arguments = @(); foreach ($value in @($request.args)) { $arguments += [string]$value }
    $environment = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([StringComparer]::OrdinalIgnoreCase)
    if ($null -ne $request.env) { foreach ($property in $request.env.PSObject.Properties) { $environment.Add([string]$property.Name, [string]$property.Value) } }
    $result = [XiaofengGameLaunchBroker]::Launch([string]$request.exe, $arguments, $environment, [string]$request.cwd,
      [string]$request.expected.userSid, [uint32]$request.expected.sessionId, [uint32]$request.expected.shellPid)
    Send-Result $true $result $null $null
  } else { Fail 'GAME_LAUNCH_REQUEST_INVALID' 'Request operation is invalid.' }
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = if ($exception.Data.Contains('Code')) { [string]$exception.Data['Code'] } elseif ($exception.Message -match '^(GAME_LAUNCH_[A-Z_]+)\|(.*)$') { $Matches[1] } else { 'GAME_LAUNCH_HELPER_FAILED' }
  $message = if ($exception.Message -match '^GAME_LAUNCH_[A-Z_]+\|(.*)$') { $Matches[1] } else { $exception.Message }
  Send-Result $false $null $code $message
  exit 1
}
