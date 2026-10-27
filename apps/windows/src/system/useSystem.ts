// Samples the PC's vitals every 2 s while the System tab is mounted (nothing runs while it is closed, as on the Mac).

import { invoke } from "@tauri-apps/api/core"
import { useEffect, useState } from "react"
import { inTauri } from "../bridge"
import { DEMO_SAMPLE, EMPTY_SAMPLE, pushHistory, type Sample } from "./model"

export const SAMPLE_INTERVAL_MS = 2000

export interface SystemData {
  sample: Sample
  cpuHistory: number[]
  memoryHistory: number[]
  networkHistory: number[]
}

const EMPTY: SystemData = { sample: EMPTY_SAMPLE, cpuHistory: [], memoryHistory: [], networkHistory: [] }

export function advance(data: SystemData, sample: Sample): SystemData {
  const memory = sample.memoryTotal === 0 ? 0 : sample.memoryUsed / sample.memoryTotal
  return {
    sample,
    cpuHistory: pushHistory(data.cpuHistory, sample.cpu),
    memoryHistory: pushHistory(data.memoryHistory, memory),
    networkHistory: pushHistory(data.networkHistory, sample.downBytesPerSecond + sample.upBytesPerSecond),
  }
}

/** A moving reading for a browser preview (no Rust): the demo sample with a little life. */
let tick = 0
function demo(): Sample {
  tick++
  const wave = Math.sin(tick / 2.5)
  return { ...DEMO_SAMPLE, cpu: 0.34 + 0.18 * wave, downBytesPerSecond: DEMO_SAMPLE.downBytesPerSecond * (1.1 + wave), memoryUsed: DEMO_SAMPLE.memoryUsed * (1 + 0.04 * wave) }
}

export function useSystem(): SystemData {
  const [data, setData] = useState<SystemData>(EMPTY)
  useEffect(() => {
    let alive = true
    const read = async () => {
      const sample = inTauri ? await invoke<Sample>("system_sample").catch(() => null) : demo()
      if (alive && sample) setData((d) => advance(d, sample))
    }
    void read()
    const timer = setInterval(read, SAMPLE_INTERVAL_MS)
    return () => {
      alive = false
      clearInterval(timer)
      if (inTauri) void invoke("system_stop").catch(() => {})
    }
  }, [])
  return data
}
