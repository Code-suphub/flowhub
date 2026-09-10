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
  function arrange(cards,moving=null,wanted=null){
    const placed=[];
    for(const c of cards.filter(c=>c.id!==moving)){
      const size={id:c.id,w:c.width||({small:184,medium:384,large:384}[c.size]),h:c.height||({small:184,medium:184,large:384}[c.size])};
      let p={...size,x:c.x??0,y:c.y??0};
      if(c.x==null||placed.some(q=>overlaps(p,q)))p=slot(placed,size,c.x==null&&placed.length?{x:placed.at(-1).x+placed.at(-1).w+gap,y:placed.at(-1).y}:p);
      placed.push(p);
    }
    if(moving){const c=cards.find(c=>c.id===moving);placed.push(slot(placed,{id:c.id,w:c.width||184,h:c.height||184},wanted));}
    // Slide every card into vacated space without crossing its neighbours.
    // Horizontal compaction first preserves the user's row choice on a drop.
    for(let pass=0;pass<placed.length+1;pass++){
      let changed=false;
      for(const p of [...placed].sort((a,b)=>a.x-b.x||a.y-b.y)){
        const left=placed.filter(q=>q!==p&&q.x<p.x&&p.y<q.y+q.h+gap&&p.y+p.h+gap>q.y);
        const x=Math.max(0,...left.map(q=>q.x+q.w+gap));
        if(x<p.x){p.x=x;changed=true;}
      }
      for(const p of [...placed].sort((a,b)=>a.y-b.y||a.x-b.x)){
        const above=placed.filter(q=>q!==p&&q.y<p.y&&p.x<q.x+q.w+gap&&p.x+p.w+gap>q.x);
        const y=Math.max(0,...above.map(q=>q.y+q.h+gap));
        if(y<p.y){p.y=y;changed=true;}
      }
      if(!changed)break;
    }
    const minX=placed.length?Math.min(...placed.map(p=>p.x)):0,minY=placed.length?Math.min(...placed.map(p=>p.y)):0;
    return placed.map(p=>({...p,x:p.x-minX,y:p.y-minY}));
  }
  root.WidgetLayout={arrange,slot,overlaps};
  if(typeof module!=='undefined')module.exports=root.WidgetLayout;
})(globalThis);
