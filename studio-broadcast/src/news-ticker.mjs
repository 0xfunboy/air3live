// Fresh facts are supplied by the producer. Alternate publishers instead of
// letting a busy feed occupy all twelve visible slots.
export function newsTicker(items,limit=12){
 const groups=new Map();
 for(const item of items){const key=item.source?.name??'';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(item);}
 const selected=[];
 while(selected.length<limit){let added=false;for(const entries of groups.values()){if(!entries.length)continue;selected.push(entries.shift());added=true;if(selected.length===limit)break;}if(!added)break;}
 return selected.map(item=>`${new Date(item.publishedAt).toISOString().slice(11,16)} UTC — ${item.title}`.slice(0,320));
}
