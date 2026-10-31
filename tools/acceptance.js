(async()=>{
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const J=window.__jphone; const R=window.__R=[]; const ok=(name,cond,detail)=>R.push((cond?'PASS ':'FAIL ')+name+(detail?' ('+detail+')':''));
 const until=async(f,ms=60000)=>{const t=Date.now();while(Date.now()-t<ms){if(f())return true;await sleep(250)}return false};
 const tap=el=>{el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));el.click()};
 // 1. pairing: host prefilled from the page URL (user only types the code)
 ok('host prefilled from page URL', document.getElementById('pair-host').value===location.hostname, document.getElementById('pair-host').value);
 const c=document.getElementById('pair-code'); c.value=window.__CODE; c.dispatchEvent(new Event('input'));
 ok('pairs on 6th digit', await until(()=>document.getElementById('app').dataset.view==='chat',8000));
 // 2. folder sheet appears, choose project
 ok('folder sheet opens after pairing', await until(()=>!!document.getElementById('dir-input'),3000));
 document.getElementById('dir-input').value=window.__DIR; document.getElementById('dir-ok').click();
 ok('connected', await until(()=>J.state.phase==='connected' && J.state.sessionId,8000), (J.state.sessionId||'').split('_')[1]);
 // 3. real turn with a tool call
 const i=document.getElementById('input');
 i.value='Use one bash call to run: ls web/lib | wc -l . Then answer with just the number in **bold**.'; i.dispatchEvent(new Event('input'));
 ok('send button enabled', !document.getElementById('send').disabled);
 tap(document.getElementById('send'));
 ok('stop button shown while running', await until(()=>document.getElementById('send').dataset.mode==='stop',5000));
 ok('status line visible', await until(()=>document.getElementById('status').classList.contains('on'),5000));
 ok('tool card rendered', await until(()=>document.querySelector('.tool[data-status="done"] .t-name')?.textContent==='bash',60000));
 ok('turn finished', await until(()=>!J.state.processing,60000));
 const ans=[...document.querySelectorAll('.msg-assistant .md strong')].map(e=>e.textContent).pop();
 ok('markdown bold rendered with the real answer', /^\d+$/.test(ans||''), ans);
 ok('pinned to newest message', (s=>s.scrollHeight-s.scrollTop-s.clientHeight<4)(document.getElementById('scroller')));
 // 4. tool card opens on tap and shows output
 const sum=document.querySelector('.tool summary'); tap(sum); await sleep(300);
 ok('tool card expands with output', /\d/.test([...document.querySelectorAll('.tool[open] pre')].pop()?.textContent||''));
 // 5. reconnect mid-session
 J.conn.ws.close();
 ok('reconnects after drop', await until(()=>J.state.phase==='connected',15000));
 ok('history restored after reconnect', await until(()=>document.querySelectorAll('.msg').length>=2,8000), document.querySelectorAll('.msg').length+' msgs');
 // 6. tap-target sizes on the real build
 const small=[...document.querySelectorAll('button,summary')].filter(e=>e.offsetParent).filter(e=>{const r=e.getBoundingClientRect();return r.height<36}).map(e=>e.className||e.tagName);
 ok('no tap target under 36px', small.length===0, small.join(','));
})();0
