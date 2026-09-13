'use strict';
const {exactGroup,validateSession}=require('./model.cjs');
const COOLDOWN_MS=48*60*60*1000;
// Pure opt-in notification policy: host persists receipts using its existing store.
// No timer, process watcher, modal opening or automatic upload is created here.
function feedbackReminder({enabled=false,session,trigger,gameRunning,reportedSessionIds=[],history=[],now=Date.now(),cooldownMs=COOLDOWN_MS}={}){
  if(!enabled)return{show:false,reason:'not-opted-in'};
  if(!session)return{show:false,reason:'no-session'};validateSession(session);
  const key=exactGroup({session}).key;
  if(session.scope!=='game'||session.contextSource!=='launch-snapshot')return{show:false,key,reason:'not-a-bound-game-session'};
  if(gameRunning!==false)return{show:false,key,reason:'game-running-or-unknown'};
  if(!['game-ended','returned-to-manager'].includes(trigger))return{show:false,key,reason:'wrong-trigger'};
  if(reportedSessionIds.includes(session.sessionId))return{show:false,key,reason:'already-reported'};
  const wait=Number.isFinite(cooldownMs)&&cooldownMs>=60*1000?cooldownMs:COOLDOWN_MS;
  const previous=history.filter(r=>r&&r.key===key&&Number.isFinite(r.at));
  // Clock moved backward: do not flood users with notices.
  if(previous.some(r=>r.at>now||now-r.at<wait))return{show:false,key,reason:'cooldown'};
  return{show:true,key,reason:'eligible',message:'这次效果怎么样？点几下就能帮我们改进。',receipt:{key,sessionId:session.sessionId,at:now}};
}
module.exports={feedbackReminder,COOLDOWN_MS};
