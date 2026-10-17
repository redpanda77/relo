import type { Notification } from "pg";
import { currentSubjectIdSchema,type CurrentChangeHint } from "@relo/notification-contracts";
import { ChangeSubscription } from "./interaction-change-hub.js";

/** Empty IDs mean reconcile the current inventory. No durable stream cursor exists. */
export class CurrentChangeSubscription {
  private readonly wake: ChangeSubscription;
  private readonly ids = new Set<string>();
  private all = false;
  private closed = false;
  constructor(onClose: () => void) { this.wake=new ChangeSubscription(onClose); }
  notify(subjectId?: string): void {
    if(this.closed)return;
    if(!subjectId){this.all=true;this.ids.clear();}
    else if(!this.all){
      this.ids.add(subjectId);
      if(this.ids.size>50){this.all=true;this.ids.clear();}
    }
    this.wake.notify();
  }
  take(): CurrentChangeHint {
    const hint={subjectIds:this.all?[]:[...this.ids],invalidateCounts:true};
    this.ids.clear();this.all=false;this.wake.clear();return hint;
  }
  wait(timeoutMs:number,signal?:AbortSignal) { return this.wake.wait(timeoutMs,signal); }
  close():void { if(this.closed)return;this.closed=true;this.wake.close(); }
}

/** Bounded synchronous fanout; no query or promise is started per NOTIFY. */
export class CurrentChangeHub {
  private readonly watchers=new Map<string,Set<CurrentChangeSubscription>>();
  private readonly credentials=new Map<string,number>();
  private count=0;
  private closed=false;
  subscribe(principalId:string,credentialId:string):CurrentChangeSubscription|null {
    if(this.closed || this.count>=1_000 || (this.credentials.get(credentialId)??0)>=16)return null;
    const subscriptions=this.watchers.get(principalId)??new Set<CurrentChangeSubscription>();
    const subscription=new CurrentChangeSubscription(()=>{
      subscriptions.delete(subscription);if(!subscriptions.size)this.watchers.delete(principalId);
      const remaining=(this.credentials.get(credentialId)??1)-1;
      if(remaining)this.credentials.set(credentialId,remaining);else this.credentials.delete(credentialId);
      this.count--;
    });
    subscriptions.add(subscription);this.watchers.set(principalId,subscriptions);
    this.credentials.set(credentialId,(this.credentials.get(credentialId)??0)+1);this.count++;
    // Subscribe first, then request a fresh read: bootstrap and reconnect have no gap.
    subscription.notify();return subscription;
  }
  receive(message?:Notification):void {
    if(this.closed)return;
    if(!message){for(const set of this.watchers.values())for(const sub of set)sub.notify();return;}
    if(!message.payload || message.payload.length>256)return;
    try{
      const input:unknown=JSON.parse(message.payload);
      if(!input || typeof input!=="object")return;
      const {principalId,subjectId}=input as Record<string,unknown>;
      if(typeof principalId!=="string" || (subjectId!==null && !currentSubjectIdSchema.safeParse(subjectId).success))return;
      for(const sub of this.watchers.get(principalId)??[])sub.notify(subjectId===null?undefined:subjectId as string);
    }catch{/* Periodic current reconciliation also recovers malformed/missed hints. */}
  }
  close():void {
    if(this.closed)return;this.closed=true;
    for(const set of this.watchers.values())for(const sub of set)sub.close();
  }
}
