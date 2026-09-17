(function(root){
  const gap=10;
  const overlaps=(a,b)=>a.x<b.x+b.w+gap&&a.x+a.w+gap>b.x&&a.y<b.y+b.h+gap&&a.y+a.h+gap>b.y;
  function slot(placed,size,wanted={x:0,y:0}){
    const xs=new Set([0]),ys=new Set([0]);
    for(const p of placed){xs.add(p.x);xs.add(p.x+p.w+gap);ys.add(p.y);ys.add(p.y+p.h+gap);}
    let best=null,score=Infinity;
    for(const x of xs)for(const y of ys){const p={...size,x,y};if(placed.some(q=>overlaps(p,q)))continue;const d=(x-wanted.x)**2+(y-wanted.y)**2;if(d<score){best=p;score=d;}}
    return best||{...size,x:0,y:Math.max(0,...placed.map(p=>p.y+p.h+gap))};
  }
  const rect=c=>({id:c.id,x:c.x,y:c.y,w:c.width||184,h:c.height||184});
  function swap(cards,moving,target){
    const a=cards.find(c=>c.id===moving),b=cards.find(c=>c.id===target);
    if(!a||!b||a===b||[a.x,a.y,b.x,b.y].some(v=>!Number.isFinite(v)))return null;
    const result=cards.map(c=>({...rect(c),...(c===a?{x:b.x,y:b.y}:c===b?{x:a.x,y:a.y}:{})}));
    const changed=result.filter(c=>c.id===moving||c.id===target);
    if(changed.some(c=>result.some(other=>other!==c&&overlaps(c,other))))return null;
    return result;
  }
  function swapTarget(cards,moving,point){
    if(!point)return null;
    // The centre region is deliberate; grazing a neighbour still docks normally.
    const target=cards.find(c=>{const r=rect(c);return c.id!==moving&&point.x>=r.x+r.w*.2&&point.x<=r.x+r.w*.8&&point.y>=r.y+r.h*.2&&point.y<=r.y+r.h*.8;});
    return target&&swap(cards,moving,target.id)?target.id:null;
  }
  function arrange(cards,moving=null,wanted=null,target=null){
    if(target){const exchanged=swap(cards,moving,target);if(exchanged)return exchanged;}
    const placed=[];
    // Resolve old overlaps in visual order, not historical creation order.
    // Reserve positioned cards first so newly added cards cannot displace them.
    const fixed=cards.filter(c=>c.id!==moving).sort((a,b)=>{
      const aPlaced=a.x!=null&&a.y!=null,bPlaced=b.x!=null&&b.y!=null;
      return Number(bPlaced)-Number(aPlaced)||(a.y??0)-(b.y??0)||(a.x??0)-(b.x??0)||String(a.id).localeCompare(String(b.id));
    });
    for(const c of fixed){
      const size={id:c.id,w:c.width||({small:184,medium:384,large:384}[c.size]),h:c.height||({small:184,medium:184,large:384}[c.size])};
      let p={...size,x:c.x??0,y:c.y??0};
      if(c.x==null||placed.some(q=>overlaps(p,q)))p=slot(placed,size,c.x==null&&placed.length?{x:placed.at(-1).x+placed.at(-1).w+gap,y:placed.at(-1).y}:p);
      placed.push(p);
    }
    if(moving){const c=cards.find(c=>c.id===moving);placed.push(slot(placed,{id:c.id,w:c.width||184,h:c.height||184},wanted));}
    // Refresh/reload must not compact or translate a saved layout. Dragging
    // places only the selected card; neighbours retain their coordinates.
    return placed;

  }
  root.WidgetLayout={arrange,slot,overlaps,swapTarget,swap};
  if(typeof module!=='undefined')module.exports=root.WidgetLayout;
})(globalThis);
