const WebSocket = require('ws'); const fs = require('fs');
const clips = JSON.parse(process.argv[2]);
fetch('http://localhost:9223/json').then(r=>r.json()).then(list=>{
  const page = list.find(t=>t.type==='page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, {maxPayload: 200*1024*1024});
  let i=0, id=0;
  ws.on('open',()=>next());
  function next(){ if(i>=clips.length){process.exit(0)} const c=clips[i++]; ws.send(JSON.stringify({id:++id,method:'Page.captureScreenshot',params:{format:'png',clip:{x:c.x,y:c.y,width:c.w,height:c.h,scale:2}}})) }
  ws.on('message',(d)=>{
    const m=JSON.parse(d);
    if(m.id&&m.result){fs.writeFileSync(`C:/Users/Administrator/Desktop/q-${clips[i-1].name}.png`,Buffer.from(m.result.data,'base64'));console.log('saved',clips[i-1].name);next()}
  });
  setTimeout(()=>{console.log('TIMEOUT');process.exit(1)},25000);
})
