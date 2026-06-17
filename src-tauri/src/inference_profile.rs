/// 按 Mac 硬件自动选择 llama-server 参数（Metal GPU、线程、上下文）。
use crate::platform_caps::{is_apple_silicon, physical_cpu_count, system_memory_gb};

pub struct InferenceProfile {
    pub ctx_size: u32,
    pub gpu_layers: u32,
    pub threads: u32,
}

pub fn detect_inference_profile() -> InferenceProfile {
    let memory_gb = system_memory_gb();
    let apple_silicon = is_apple_silicon();
    let threads = physical_cpu_count().max(4);

    if apple_silicon {
        if memory_gb >= 16.0 {
            InferenceProfile {
                ctx_size: 4096,
                gpu_layers: 99,
                threads,
            }
        } else if memory_gb >= 12.0 {
            InferenceProfile {
                ctx_size: 3072,
                gpu_layers: 60,
                threads,
            }
        } else {
            InferenceProfile {
                ctx_size: 2048,
                gpu_layers: 32,
                threads: threads.min(6),
            }
        }
    } else {
        InferenceProfile {
            ctx_size: if memory_gb >= 16.0 { 3072 } else { 2048 },
            gpu_layers: 0,
            threads,
        }
    }
}
