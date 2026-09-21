import { resetDemo, demoSize } from './demo-api.js';
const select=document.querySelector('#demo-size');select.value=String(demoSize());
select.addEventListener('change',()=>{resetDemo(Number(select.value));location.reload();});
document.querySelector('#demo-reset').addEventListener('click',()=>{resetDemo();location.reload();});
if(document.querySelector('#printer-form')) {
  // The production form remains recognizable while credential inputs are inert.
  for(const name of ['apiKey','clearApiKey','cameraStream']){const input=document.querySelector(`[name="${name}"]`);input.disabled=true;}
  document.querySelector('[name="apiKey"]').placeholder='Unavailable in the public demo';
  const p=document.createElement('p');p.className='notice';p.textContent='Try adding, discovering or editing a simulated printer. Addresses stay fictional, API keys are disabled, and changes last for this browser tab only.';
  document.querySelector('.settings-heading').append(p);
}
