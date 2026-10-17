#!/usr/bin/env node
// The iPhone app styles through its templates (docs/product/IOS-DESIGN.md): one button style, one sheet
// scaffold, one confirmation, one caps label, semantic colors. Screens that style in place fail here.
// Template and HUD files own the primitives. BASELINE holds what is left to move, per file; it may only
// shrink, and this check says when a count drops so the entry can be tightened. A deliberate exception (a
// wordmark, chart axis text) carries `// design: <why>` on its line. SF Symbols sized to the mark they sit
// in (a check inside a dot) may keep a fixed size.
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../apps/ios/Sources/ReloApp');
const templates=new Set(['ReloButtonStyle.swift','ReloSheet.swift','ReloConfirmSheet.swift','ReloComponents.swift',
  'ReloVisualSystem.swift','ReloLayout.swift','ReloStatusChip.swift']);
const hud=new Set(['ReloAtmosphere.swift','ReloHUDModule.swift','ReloHoloHUD.swift','ReloHoloTheme.swift',
  'ReloNowDeck.swift','ReloNowHero.swift','ReloOrbitPlane.swift',
  // Live Activity visuals draw the sender's own colors.
  'ReloActivityVisual.swift']);
const rules={
  'system red':{pattern:/Color\.red\b|\.tint\(\.red\)|foregroundStyle\(\.red\)/g,use:'Color.reloDestructive'},
  'system button style':{pattern:/\.buttonStyle\(\.(?:borderedProminent|bordered)\)/g,use:'.buttonStyle(.reloPrimary / .reloSecondary / .reloDestructive)'},
  'system dialog':{pattern:/\.confirmationDialog\(|\.alert\(/g,use:'.reloConfirmation(…) (ReloConfirmSheet)'},
  'raw empty state':{pattern:/ContentUnavailableView\b/g,use:'ReloEmptyState'},
  'raw color':{pattern:/Color\((?:red|hex):|Color\(\.sRGB/g,use:'a token in ReloVisualSystem.swift'},
  'HUD orange':{pattern:/ReloHoloTheme\.orange\b/g,use:'Color.reloAttention'},
  'hand tracking':{pattern:/\.tracking\(\s*-?\d/g,use:'ReloMonoLabel (ReloLayout.labelTracking)'},
  'fixed font size':{pattern:/\.font\(\.system\(size:/g,use:'a text style (.headline, .title3, …)'},
};
// Files still being moved onto the templates: the most each may hold. Lower these, never raise them.
const BASELINE={
  'CurrentAttentionView.swift':{'system button style':3,'system dialog':1,'hand tracking':2},
  'NowView.swift':{'system button style':1},
};

const failures=[];const tighten=[];
for(const name of readdirSync(directory).filter(file=>file.endsWith('.swift')).sort()){
  if(templates.has(name)||hud.has(name))continue;
  const code=readFileSync(join(directory,name),'utf8').split('\n').filter(line=>!line.includes('// design:')).join('\n')
    .replace(/\/\/[^\n]*/g,'').replace(/Image\(systemName:[^\n]*\n?\s*\.font\(\.system\(size:/g,'Image(');
  for(const [rule,{pattern,use}] of Object.entries(rules)){
    const count=(code.match(pattern)??[]).length;
    const allowed=BASELINE[name]?.[rule]??0;
    if(count>allowed)failures.push(`${name}: ${count} × ${rule} (allowed ${allowed}); use ${use}`);
    else if(count<allowed)tighten.push(`${name}: ${rule} is down to ${count}; set its BASELINE to ${count}`);
  }
}
if(tighten.length)console.error(`Tighten scripts/check-ios-design-system.mjs:\n  ${tighten.join('\n  ')}`);
if(failures.length){
  console.error(`The iPhone app styles through its templates (ReloButtonStyle, ReloSheet, ReloConfirmSheet, ReloMonoLabel, tokens):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(JSON.stringify({ok:true,rules:Object.keys(rules).length,baselined:Object.keys(BASELINE).length}));
