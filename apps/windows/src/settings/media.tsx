// The Media page (SettingsView.swift `Media`, plus the Media section of `Appearance`): the music source, the closed
// notch's live activity and sneak peek, the inactivity timeout, full screen behavior, the slot layout and lyrics.
// Its settings are their own file (%APPDATA%\Relo\media.json, see src/music/settings.ts), so the page takes no props.
//
// Registration (one line each, in files this change does not own):
//   SettingsApp.tsx  PAGES:   { id: "media", title: "Media", color: "#e0457d", group: "notch", icon: svg("M5 3.5l8 4.5-8 4.5z") }
//   SettingsApp.tsx  <main>:  {page === "media" && <MediaPage />}
// and `import { MediaPage } from "./media"`.

import { SlotConfig } from "../music/SlotConfig"
import { useMediaSettings } from "../music/settings"
import { SOURCES, type HideNotchOption, type SliderColor, type Source, type SneakPeekStyle } from "../music/types"
import { Group, Page, Row, Select, Segmented, ToggleRow } from "./ui"

export function MediaPage() {
  const { settings: m, update, loaded } = useMediaSettings()
  if (!loaded) return null
  return (
    <Page title="Media" detail="What the notch shows while music plays">
      <Group
        title="Media Source"
        footer={
          m.source === "youtubeMusic"
            ? "YouTube Music needs the YouTube Music desktop app (pear-desktop) with its API Server plugin turned on: github.com/pear-devs/pear-desktop"
            : "Now Playing follows whatever Windows shows in its media controls and works with every media app. Pick a service to follow only it."
        }
      >
        <Row title="Music Source">
          <Select<Source> label="Music Source" value={m.source} options={SOURCES} onChange={(source) => update({ source })} />
        </Row>
      </Group>

      <Group title="Media playback live activity">
        <ToggleRow title="Show music live activity" checked={m.liveActivity} onChange={(liveActivity) => update({ liveActivity })} />
        <ToggleRow title="Show sneak peek on playback changes" checked={m.sneakPeek} onChange={(sneakPeek) => update({ sneakPeek })} />
        <Row title="Sneak Peek Style" disabled={!m.sneakPeek}>
          <Segmented<SneakPeekStyle>
            label="Sneak Peek Style"
            value={m.sneakPeekStyle}
            options={[
              { value: "standard", label: "Default" },
              { value: "inline", label: "Inline" },
            ]}
            onChange={(sneakPeekStyle) => update({ sneakPeekStyle })}
          />
        </Row>
        <Row title="Media inactivity timeout" detail={`${m.waitInterval} seconds`}>
          <input type="range" min={0} max={10} step={1} value={m.waitInterval} aria-label="Media inactivity timeout" onChange={(e) => update({ waitInterval: Number(e.target.value) })} />
        </Row>
        <Row title="Full screen behavior" detail="Beta">
          <Select<HideNotchOption>
            label="Full screen behavior"
            value={m.hideNotchOption}
            options={[
              { value: "always", label: "Hide for all apps" },
              { value: "nowPlayingOnly", label: "Hide for media app only" },
              { value: "never", label: "Never hide" },
            ]}
            onChange={(hideNotchOption) => update({ hideNotchOption })}
          />
        </Row>
      </Group>

      <Group title="Media controls" footer="Customize which controls appear in the music player. Volume expands when active; it works with YouTube Music only, as Windows media controls have no volume.">
        <SlotConfig slots={m.slots} onChange={(slots) => update({ slots })} />
        <ToggleRow title="Show lyrics below artist name" detail="Beta. From LRCLIB, synced when available." checked={m.lyrics} onChange={(lyrics) => update({ lyrics })} />
      </Group>

      <Group title="Media appearance">
        <ToggleRow title="Colored spectrogram" checked={m.coloredSpectrogram} onChange={(coloredSpectrogram) => update({ coloredSpectrogram })} />
        <ToggleRow title="Player tinting" checked={m.playerColorTinting} onChange={(playerColorTinting) => update({ playerColorTinting })} />
        <ToggleRow title="Enable blur effect behind album art" checked={m.lightingEffect} onChange={(lightingEffect) => update({ lightingEffect })} />
        <ToggleRow title="Round album art with the notch" checked={m.cornerRadiusScaling} onChange={(cornerRadiusScaling) => update({ cornerRadiusScaling })} />
        <Row title="Slider color">
          <Select<SliderColor>
            label="Slider color"
            value={m.sliderColor}
            options={[
              { value: "white", label: "White" },
              { value: "albumArt", label: "Match album art" },
              { value: "accent", label: "Accent color" },
            ]}
            onChange={(sliderColor) => update({ sliderColor })}
          />
        </Row>
      </Group>
    </Page>
  )
}
