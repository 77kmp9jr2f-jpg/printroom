import test from 'node:test';
import assert from 'node:assert/strict';
import { colorLibrary, filterColors, swatchBackground } from '../web/color-library.js';
const filament = {id:10,name:'Silk Silver',material:'PLA',vendor:{name:'Maker'},color_hex:'C0C0C0',extra:{printroom_finish:'"Silk"',printroom_color_basis:'"Published hex"'}};
test('library groups physical spools by filament, preserves unknown mass, and distinguishes incoming and archived',()=>{
 const library=colorLibrary([{id:1,filament,remaining_weight:null},{id:2,filament,remaining_weight:50},{id:3,filament,location:'On order - weight unknown'},{id:4,filament,archived:true}]);
 assert.equal(library.length,1);const c=library[0];
 assert.equal(c.spools.length,4);assert.equal(c.active,2);assert.equal(c.incoming,1);assert.equal(c.archived,1);
 assert.equal(c.knownGrams,50);assert.equal(c.unknownWeight,1);assert.deepEqual(c.colors,['#C0C0C0']);
 assert.equal(c.finish,'Silk');
});
test('same color across distinct filaments stays distinct; filtering is case insensitive',()=>{
 const library=colorLibrary([{id:1,filament},{id:2,filament:{...filament,id:11,material:'PETG',name:'Solid Silver'}}]);
 assert.equal(library.length,2);
 assert.equal(filterColors(library,{query:'MAKER',material:'PETG'}).length,1);
 assert.equal(filterColors(library,{query:'missing'}).length,0);
 assert.equal(filterColors(library,{finish:'Matte'}).length,0);
});
test('multi-color and alpha are supported without accepting CSS or script injection',()=>{
 const c=colorLibrary([{id:1,filament:{id:4,multi_color_hexes:'FF0000,00ff0080',multi_color_direction:'coaxial',extra:{printroom_color_source:'"javascript:alert(1)"'}}}])[0];
 assert.deepEqual(c.colors,['#FF0000','#00FF0080']);assert.equal(c.source,null);
 assert.match(swatchBackground(c),/linear-gradient/);
 const bad=colorLibrary([{id:2,filament:{id:5,color_hex:'red;background:url(evil)',extra:{printroom_finish:'bad JSON'}}}])[0];
 assert.deepEqual(bad.colors,[]);assert.equal(swatchBackground(bad),null);
});
test('inventory library reads later pages and rejects stalled or failing pagination',async()=>{
 const {loadSpools}=await import('../web/color-library.js');const paths=[];
 const r=await loadSpools(async path=>{paths.push(path);return paths.length===1?{spools:[{id:1}],nextOffset:100}:{spools:[{id:2}],nextOffset:null};});
 assert.deepEqual(r.spools.map(s=>s.id),[1,2]);assert.equal(paths[1],'/api/v1/spools?offset=100');
 await assert.rejects(loadSpools(async()=>({spools:[],nextOffset:0})),/advance/);
 let i=0;await assert.rejects(loadSpools(async()=>{if(i++)throw new Error('offline');return {spools:[{id:1}],nextOffset:100};}),/offline/);
});
test('inventory rejects pages from different Spoolman revisions instead of combining colliding spool IDs', async () => {
 const { loadSpools } = await import('../web/color-library.js'); let page = 0;
 await assert.rejects(loadSpools(async () => ++page === 1 ? { spools: [{id:1}], nextOffset: 100, spoolmanRevision: 1 } : { spools: [{id:1}], nextOffset: null, spoolmanRevision: 2 }), /connection changed/);
});
