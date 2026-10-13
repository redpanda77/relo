import type { Database } from "./db.js";
import { PostgresListener } from "./postgres-listener.js";
import { InteractionChangeHub } from "./interaction-change-hub.js";
import { CurrentChangeHub } from "./current-change-hub.js";

/** Exactly one owned LISTEN connection for both API fanout domains. */
export class ApiChangeListener {
  readonly interactions=new InteractionChangeHub();
  readonly current=new CurrentChangeHub();
  private listener:PostgresListener|undefined;
  static async listen(db:Database):Promise<ApiChangeListener>{
    const owner=new ApiChangeListener();
    owner.listener=await PostgresListener.listen(db,["relo_interaction_changes","relo_current_changes"],message=>{
      if(!message || message.channel==="relo_interaction_changes")owner.interactions.receive(message);
      if(!message || message.channel==="relo_current_changes")owner.current.receive(message);
    });
    return owner;
  }
  async close():Promise<void>{
    this.current.close();await this.interactions.close();await this.listener?.close();
  }
}
