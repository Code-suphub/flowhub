// Variable-height result window. Usage strips are indivisible groups.
(() => {
  window.FlowHubResultWindow = class {
    constructor() { this.heights = new Map(); }
    groups(items, key) {
      const groups=[]; let top=0;
      for(let i=0;i<items.length;) {
        const start=i, section=items[i].usageSection;
        if(section) { while(i<items.length && items[i].usageSection===section) i++; } else i++;
        const id=section?`usage:${section}`:key(items[start]);
        const height=this.heights.get(id) || (section?130:80);
        groups.push({start,end:i,id,top,height}); top+=height;
      }
      return {groups,total:top};
    }
    plan(items,key,scrollTop,viewport,targetIndex) {
      const {groups,total}=this.groups(items,key);
      let anchor=targetIndex==null?groups.findIndex(g=>g.top+g.height>scrollTop):groups.findIndex(g=>g.start<=targetIndex&&g.end>targetIndex);
      if(anchor<0)anchor=Math.max(0,groups.length-1);
      const first=Math.max(0,anchor-8);
      let last=anchor;
      while(last<groups.length && groups[last].top<groups[anchor].top+viewport+640)last++;
      last=Math.min(groups.length,Math.max(last,anchor+9));
      const visible=groups.slice(first,last);
      return {groups:visible,from:visible[0]?.start||0,to:visible.at(-1)?.end||0,before:visible[0]?.top||0,after:total-(visible.at(-1)?visible.at(-1).top+visible.at(-1).height:0),targetTop:groups[anchor]?.top||0};
    }
  };
})();
