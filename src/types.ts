export type Page = 'Overview' | 'Posts' | 'Audience' | 'Grow' | 'Monetize' | 'Automations' | 'Website' | 'Analytics' | 'Settings';
export type Post = {id:string; title:string; subtitle:string; content:string; status:'Draft'|'Scheduled'|'Published'; date:string; audience:string; opens:number; clicks:number; image:string; subjectB?:string;};
export type Subscriber = {id:string; name:string; email:string; status:'Active'|'Unsubscribed'; tier:'Free'|'Premium'; source:string; joined:string; openRate:number; tags:string[];};
export type Automation = {id:string; name:string; description:string; active:boolean; enrolled:number; steps:string[];};
export type Product = {id:string; name:string; description:string; price:number; type:string; sales:number;};
export type AppData = {posts:Post[]; subscribers:Subscriber[]; automations:Automation[]; products:Product[]; publication:{name:string;description:string;domain:string;sender:string;accent:string}; team:{name:string;email:string;role:string}[]; apiKeys:{id:string;name:string;key:string}[];};
export type SharedProps = {data:AppData; updateData:(fn:(previous:AppData)=>AppData)=>void; notify:(message:string)=>void; navigate:(page:Page)=>void;};
