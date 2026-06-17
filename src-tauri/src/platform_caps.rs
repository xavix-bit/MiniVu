/// 本机硬件能力探测（Apple Silicon、内存、CPU），供推理配置与设备信息共用。

pub fn is_apple_silicon() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("uname")
            .arg("-m")
            .output()
            .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "arm64")
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

pub fn system_memory_gb() -> f64 {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl")
            .args(["-n", "hw.memsize"])
            .output()
            .ok()
            .and_then(|output| {
                String::from_utf8(output.stdout)
                    .ok()
                    .and_then(|text| text.trim().parse::<u64>().ok())
            })
            .map(|bytes| bytes as f64 / (1024.0 * 1024.0 * 1024.0))
            .unwrap_or(8.0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        8.0
    }
}

pub fn physical_cpu_count() -> u32 {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sysctl")
            .args(["-n", "hw.physicalcpu"])
            .output()
            .ok()
            .and_then(|output| {
                String::from_utf8(output.stdout)
                    .ok()
                    .and_then(|text| text.trim().parse::<u32>().ok())
            })
            .unwrap_or(4)
    }
    #[cfg(not(target_os = "macos"))]
    {
        4
    }
}
