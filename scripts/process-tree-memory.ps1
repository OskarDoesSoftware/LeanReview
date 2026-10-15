param([int]$RootProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class LeanReviewMemory {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Entry {
        public uint size, usage, pid; public UIntPtr heap; public uint module, threads, parent;
        public int priority; public uint flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string name;
    }
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public class Row { public int pid, parent; public long rss; public string name; }
    public static List<Row> Sample(int root) {
        var snapshot=CreateToolhelp32Snapshot(2,0);
        if(snapshot==new IntPtr(-1)) throw new InvalidOperationException("Process enumeration failed.");
        var entries=new List<Entry>();
        try {
            var entry=new Entry {size=(uint)Marshal.SizeOf(typeof(Entry))};
            if(!Process32FirstW(snapshot,ref entry)) throw new InvalidOperationException("Process enumeration failed.");
            do { entries.Add(entry); } while(Process32NextW(snapshot,ref entry));
        } finally { CloseHandle(snapshot); }
        var owned=new HashSet<int> {root}; bool changed;
        do { changed=false; foreach(var entry in entries) if(owned.Contains((int)entry.parent)) changed|=owned.Add((int)entry.pid); } while(changed);
        var rows=new List<Row>();
        foreach(var entry in entries) if(owned.Contains((int)entry.pid)) {
            try { using(var process=Process.GetProcessById((int)entry.pid)) {
                rows.Add(new Row {pid=(int)entry.pid,parent=(int)entry.parent,rss=process.WorkingSet64,name=entry.name});
            }} catch(ArgumentException) {} catch(InvalidOperationException) {}
        }
        return rows;
    }
}
'@
while ($true) {
    $memoryRows = @([LeanReviewMemory]::Sample($RootProcessId))
    if (-not ($memoryRows | Where-Object { $_.pid -eq $RootProcessId })) { break }
    ConvertTo-Json -InputObject $memoryRows -Compress
    Start-Sleep -Milliseconds 200
}
