import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
export class Lifecycle {
  constructor({box, stateFile, idleMs=3600000, touchMs=30000, now=Date.now, onSleep=()=>{}, ready=async()=>{}}) {
    Object.assign(this,{box,stateFile,idleMs,touchMs,now,onSleep,ready});
    this.lastUserAt=0; this.lastTouch=0; this.awake=false; this.chain=Promise.resolve(); this.waking=null;
  }
  async load() {
    try { this.lastUserAt=JSON.parse(await readFile(this.stateFile,'utf8')).lastUserAt || 0; } catch(e) { if(e.code!=='ENOENT') throw e; }
  }
  serial(fn) { const task=this.chain.then(fn); this.chain=task.catch(()=>{}); return task; }
  async save() { if(this.stateFile){await mkdir(dirname(this.stateFile),{recursive:true}); await writeFile(this.stateFile,JSON.stringify({lastUserAt:this.lastUserAt}),{mode:0o600});} }
  async wake() {
    if(this.waking) return this.waking;
    this.waking=this.serial(async()=>{
      if(!this.awake) {
        await this.box.resume();
        const result=await this.box.exec.command('bash /workspace/home/proxy-box/start.sh');
        if(result.exitCode!==0) throw Error('Box startup failed');
        await this.ready(); this.awake=true; this.lastTouch=this.now();
      }
    }).finally(()=>{this.waking=null;});
    return this.waking;
  }
  async userActivity() {
    this.lastUserAt=this.now(); await this.save();
    await this.wake();
    return this.serial(async()=>{
      if(this.now()-this.lastTouch >= this.touchMs) {
        const result=await this.box.exec.command('date');
        if(result.exitCode!==0) throw Error('Box activity update failed');
        this.lastTouch=this.now();
      }
    });
  }
  async idle() {
    return this.serial(async()=>{
      if(!this.lastUserAt || this.now()-this.lastUserAt<this.idleMs) return;
      if(!this.awake) return;
      await this.onSleep(); await this.box.pause(); this.awake=false;
      console.log('box_paused_idle');
    });
  }
}
