#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../apps/ios');
const expected={ReloCore:[],ReloRuntime:['ReloCore'],ReloTransport:['ReloCore'],
  ReloPersistence:['ReloCore','ReloNotificationSupport'],ReloNotificationSupport:['ReloCore']};
const packageSpec=JSON.parse(execFileSync('swift',['package','dump-package'],{cwd:root,encoding:'utf8'}));
const nativeSpec=JSON.parse(execFileSync('xcodegen',['dump','--spec','project.yml','--no-env','--type','json'],{cwd:root,encoding:'utf8'}));
const packageGraph=Object.fromEntries(packageSpec.targets.map(target=>[target.name,target.dependencies.map(value=>(value.byName??value.target)[0])]));
const nativeGraph=Object.fromEntries(Object.entries(nativeSpec.targets).map(([name,target])=>[name,(target.dependencies??[]).flatMap(value=>value.target?[value.target]:[])]));
function checkAcyclic(graph){
  const complete=new Set();
  function visit(name,path){
    assert(!path.includes(name),`Target cycle: ${[...path,name].join(' -> ')}`);
    if(complete.has(name))return;
    assert(name in graph,`Missing target ${name}`);
    for(const dependency of graph[name])visit(dependency,[...path,name]);
    complete.add(name);
  }
  Object.keys(graph).forEach(name=>visit(name,[]));
}
checkAcyclic(packageGraph);checkAcyclic(nativeGraph);
for(const [name,dependencies] of Object.entries(expected)){
  assert.deepEqual([...packageGraph[name]].sort(),[...dependencies].sort(),`SwiftPM boundary: ${name}`);
  assert.deepEqual([...nativeGraph[name]].sort(),[...dependencies].sort(),`Native boundary: ${name}`);
}
function swiftFiles(directory){return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?swiftFiles(join(directory,entry.name)):entry.name.endsWith('.swift')?[join(directory,entry.name)]:[]);}
for(const name of Object.keys(expected)){
  const directory=join(root,'Sources',name==='ReloNotificationSupport'?'NotificationSupport':name);
  for(const file of swiftFiles(directory)){
    const text=readFileSync(file,'utf8');
    assert(!/@_exported\s+import/.test(text),`Umbrella export in ${file}`);
    const imports=[...text.matchAll(/^import\s+(\w+)/gm)].map(match=>match[1]);
    for(const imported of imports.filter(value=>value.startsWith('Relo')))
      assert(expected[name].includes(imported),`Forbidden dependency ${name} -> ${imported} in ${file}`);
    if(name==='ReloCore'||name==='ReloRuntime'){
      assert(!imports.some(value=>['UIKit','ActivityKit','Security'].includes(value)),`Platform adapter in ${file}`);
      const code=text.replace(/\/\/[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
      assert(!/\b(?:URLSession|FileManager|UserDefaults|NotificationReceiptFile|SecItem\w*)\b|Data\(contentsOf:/.test(code),`Concrete I/O in ${file}`);
    }
  }
}
console.log(JSON.stringify({ok:true,modules:expected,packageTargets:Object.keys(packageGraph).length,nativeTargets:Object.keys(nativeGraph).length}));
