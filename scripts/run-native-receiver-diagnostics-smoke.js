const assert=require('node:assert/strict');
const {once}=require('node:events');
const {launch,waitFor,click,cleanup}=require('./run-native-mvp-smoke');

(async()=>{
  const peer=await launch({SELF_LIVE_RELAY_URL:'',SELF_LIVE_UPNP:'off'});
  await waitFor(peer,`!document.getElementById('save-network').disabled`);
  await peer.rpc('evaluate',`document.getElementById('invitation').value='self-live://join?data=private-fixture';document.getElementById('logging').checked=true`);
  await click(peer,'join');
  await waitFor(peer,`document.getElementById('join-status').textContent.includes('prototipo da main')`);
  const first=await peer.rpc('network-summary');
  assert.equal(first.receiverLogs,1);assert.ok(first.entryFailures.includes('incompatible_invitation'));
  await peer.rpc('evaluate',`document.getElementById('invitation').value='invalid-private-fixture';document.getElementById('logging').checked=false`);
  await click(peer,'join');
  await waitFor(peer,`document.getElementById('join-status').textContent.includes('convite automatico')`);
  const second=await peer.rpc('network-summary');assert.equal(second.receiverLogs,1);
  const exited=once(peer.child,'exit');await peer.rpc('quit');await exited;
  console.log('Production receiver diagnostics: pre-media invitation error logged; logging off creates no new audit; shutdown OK.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(cleanup);
