import { useState } from "react"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/card"
import { Button } from "@/components/ui/button"
import { setSoundEnabled, testSound, useSoundEnabled } from "@/lib/sound"

/**
 * Settings → Preferences → Sound: Relo's cues in this browser (ADR 0013). Off until chosen, and kept
 * per browser. The switch is a click, which unlocks the browser's audio and confirms with the
 * linked bloom; Test plays the signature cue again.
 */
export function SoundCard() {
  const on = useSoundEnabled()
  const [busy, setBusy] = useState(false)
  async function run(action: () => Promise<void>) {
    setBusy(true)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sound</CardTitle>
        <CardDescription>
          A short cue when something needs you, fails or finishes, and when your answer is accepted. Only while this tab is
          open and visible, and never more than one every two seconds.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-accent">
          <input
            type="checkbox"
            role="switch"
            name="soundEnabled"
            className="mt-0.5 size-5 shrink-0 accent-primary"
            checked={on}
            disabled={busy}
            onChange={(event) => void run(() => setSoundEnabled(event.currentTarget.checked))}
          />
          <span className="min-w-0">
            <span className="block text-sm text-foreground">Play Relo&apos;s sounds in this browser</span>
            <span className="block max-w-[65ch] text-xs text-muted-foreground">
              Off by default. Your choice is kept in this browser only.
            </span>
          </span>
        </label>
        <div>
          <Button type="button" variant="outline" size="sm" disabled={!on || busy} onClick={() => void run(testSound)}>
            Test sound
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
