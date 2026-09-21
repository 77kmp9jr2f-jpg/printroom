const search=document.querySelector('#guide-search');
if(search)search.addEventListener('input',()=>{const query=search.value.trim().toLowerCase();document.querySelectorAll('.guide-nav a[data-guide]').forEach(a=>a.hidden=!!query&&!a.textContent.toLowerCase().includes(query));});
for(const pre of document.querySelectorAll('.guide pre')) {
 const button=document.createElement('button');button.textContent='Copy';button.className='btn';button.style.marginBottom='10px';button.style.minHeight='32px';
 button.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(pre.textContent);button.textContent='Copied';}catch{button.textContent='Select the command to copy';}setTimeout(()=>button.textContent='Copy',2000);});pre.before(button);
}
