import {useEffect, useRef, useState} from 'react';
import DOMPurify from 'dompurify';
import {ArrowLeft, ArrowUpRight, Bold, Check, CheckCheck, ChevronDown, ChevronRight, Clock3, Code2, Copy, Eye, FileText, Heading2, ImagePlus, Italic, Link2, List, Mail, Minus, MoreHorizontal, Plus, Quote, Search, Send, Settings2, Sparkles, Table2, Underline, Users, X} from 'lucide-react';
import type {Post, SharedProps} from '../types';
import './posts.css';

type Props = SharedProps & {initialPostId?:string; onOpenHandled?:()=>void};
type Block = {label:string;detail:string;icon:typeof FileText;html?:string;action?:'image'|'link'};
const blocks:Block[] = [
  {label:'Heading',detail:'Give your story a little structure',icon:Heading2,html:'<h2>Your next big idea</h2><p><br></p>'},
  {label:'Image',detail:'Add something worth a thousand words',icon:ImagePlus,action:'image'},
  {label:'Button',detail:'An invitation to take the next step',icon:ArrowUpRight,action:'link'},
  {label:'Blockquote',detail:'Make a thought stand out',icon:Quote,html:'<blockquote>A thought worth sharing.</blockquote><p><br></p>'},
  {label:'Divider',detail:'A little breathing room',icon:Minus,html:'<hr><p><br></p>'},
  {label:'Table',detail:'Keep the details organized',icon:Table2,html:'<table><tbody><tr><th>Column one</th><th>Column two</th></tr><tr><td>Add your content</td><td>Add your content</td></tr></tbody></table><p><br></p>'},
  {label:'Code block',detail:'For the technically curious',icon:Code2,html:'<pre><code>// Add your code here</code></pre><p><br></p>'},
  {label:'First name',detail:'A personal hello for every reader',icon:Users,html:'{{first_name}}'},
  {label:'Premium break',detail:'Give paying readers a little more',icon:Sparkles,html:'<hr><p class="premium-divider">✦ Premium content starts here</p><hr><p><br></p>'},
];
const formatDate = (date:string) => new Date(date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
const formatTime = (date:string) => new Date(date).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
const localDateTime = (date:string) => {const value=new Date(date);return new Date(value.getTime()-value.getTimezoneOffset()*60000).toISOString().slice(0,16);};
const clean = (html:string) => DOMPurify.sanitize(html,{ADD_ATTR:['target']});
const tomorrow = () => {const date = new Date();date.setDate(date.getDate()+1);date.setHours(9,0,0,0);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};

export default function Posts({data,updateData,notify,initialPostId,onOpenHandled}:Props) {
  const [status,setStatus] = useState('All posts');
  const [search,setSearch] = useState('');
  const [draft,setDraft] = useState<Post|null>(null);
  const [saved,setSaved] = useState(true);
  const [blockMenu,setBlockMenu] = useState(false);
  const [preview,setPreview] = useState(false);
  const [previewMode,setPreviewMode] = useState<'Email'|'Website'>('Email');
  const [previewPerson,setPreviewPerson] = useState('Olivia');
  const [schedule,setSchedule] = useState(false);
  const [scheduleDate,setScheduleDate] = useState(tomorrow);
  const [abTest,setAbTest] = useState(false);
  const [assetModal,setAssetModal] = useState<'image'|'link'|null>(null);
  const [assetUrl,setAssetUrl] = useState('');
  const [assetLabel,setAssetLabel] = useState('Read more');
  const [settings,setSettings] = useState(false);
  const [postMenu,setPostMenu] = useState<string|null>(null);
  const editor = useRef<HTMLDivElement>(null);
  const selection = useRef<Range|null>(null);
  const lastRequest = useRef<string|null>(null);
  const lastDraft = useRef<Post|null>(null);
  const saveCurrentDraft = () => {
    const current=lastDraft.current;
    if(current)updateData(previous=>({...previous,posts:previous.posts.map(post=>post.id===current.id?{...current,content:clean(current.content)}:post)}));
  };
  const resetEditorControls = () => {setSettings(false);setBlockMenu(false);setPreview(false);setSchedule(false);setAssetModal(null);setPostMenu(null);selection.current=null;};
  const newDraft = () => {
    saveCurrentDraft();
    const post:Post = {id:`post-${crypto.randomUUID()}`,title:'',subtitle:'',content:'<p><br></p>',status:'Draft',date:new Date().toISOString(),audience:'All subscribers',opens:0,clicks:0,image:''};
    updateData(previous=>({...previous,posts:[post,...previous.posts]}));
    setDraft(post);setAbTest(false);setScheduleDate(tomorrow());resetEditorControls();
  };
  const openDraft = (post:Post) => {const current=lastDraft.current?.id===post.id?lastDraft.current:post;saveCurrentDraft();setDraft({...current});setAbTest(Boolean(current.subjectB));setScheduleDate(current.status==='Scheduled'?localDateTime(current.date):tomorrow());resetEditorControls();};
  useEffect(()=>{
    if(!initialPostId){lastRequest.current=null;return;}
    if(lastRequest.current===initialPostId)return;
    lastRequest.current=initialPostId;
    if(initialPostId==='new')newDraft();
    else {const post=data.posts.find(item=>item.id===initialPostId);if(post)openDraft(post);}
    onOpenHandled?.();
  },[initialPostId]);
  useEffect(()=>{if(draft&&editor.current)editor.current.innerHTML=clean(draft.content);},[draft?.id]);
  useEffect(()=>{
    lastDraft.current=draft;
    if(!draft)return;
    setSaved(false);
    const timeout=setTimeout(()=>{
      const next={...draft,content:clean(draft.content)};
      updateData(previous=>({...previous,posts:previous.posts.map(post=>post.id===next.id?next:post)}));
      setSaved(true);
    },600);
    return()=>clearTimeout(timeout);
  },[draft]);
  useEffect(()=>()=>{const current=lastDraft.current;if(current)updateData(previous=>({...previous,posts:previous.posts.map(post=>post.id===current.id?{...current,content:clean(current.content)}:post)}));},[]);
  useEffect(()=>{
    if(!draft)return;
    const handleKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){setBlockMenu(false);setPreview(false);setSchedule(false);setAssetModal(null);}if((event.metaKey||event.ctrlKey)&&event.key==='s'){event.preventDefault();notify('Your draft is saved automatically.');}};
    window.addEventListener('keydown',handleKey);return()=>window.removeEventListener('keydown',handleKey);
  },[draft,notify]);
  const patch = (changes:Partial<Post>) => setDraft(previous=>previous?{...previous,...(previous.status==='Draft'&&!changes.date?{date:new Date().toISOString()}:{}),...changes}:previous);
  const syncEditor = () => patch({content:editor.current?.innerHTML||''});
  const rememberSelection = () => {const current=window.getSelection();if(current?.rangeCount&&editor.current?.contains(current.anchorNode))selection.current=current.getRangeAt(0).cloneRange();};
  const isSlashCommandPosition = () => {const current=window.getSelection();if(!current?.rangeCount||!editor.current)return false;const before=current.getRangeAt(0).cloneRange();before.selectNodeContents(editor.current);before.setEnd(current.anchorNode!,current.anchorOffset);return !before.toString()||/\s$/.test(before.toString());};
  const restoreSelection = () => {editor.current?.focus();if(selection.current&&editor.current?.contains(selection.current.startContainer)){const current=window.getSelection();current?.removeAllRanges();current?.addRange(selection.current);}};
  const command = (name:string,value?:string) => {restoreSelection();document.execCommand(name,false,value);syncEditor();rememberSelection();};
  const insert = (html:string) => {command('insertHTML',clean(html));setBlockMenu(false);};
  const chooseBlock=(block:Block)=>{if(block.action){setAssetModal(block.action);setAssetUrl('');setAssetLabel(block.action==='image'?'Image description':'Read more');setBlockMenu(false);}else if(block.html)insert(block.html);};
  const addAsset=()=>{
    const url=assetUrl.trim();
    if(!/^https?:\/\//i.test(url)&&!(assetModal==='image'&&url.startsWith('/images/'))){notify('Enter a full URL beginning with https://.');return;}
    const element=document.createElement(assetModal==='image'?'img':'a');
    if(assetModal==='image'){element.setAttribute('src',url);element.setAttribute('alt',assetLabel);}
    else {element.setAttribute('href',url);element.textContent=assetLabel||url;}
    insert(`<p>${element.outerHTML}</p><p><br></p>`);setAssetModal(null);
  };
  const backToPosts=()=>{saveCurrentDraft();lastDraft.current=null;setDraft(null);resetEditorControls();};
  const duplicate=(post:Post)=>{const base=post.title.trim()||'Untitled post';let title=`${base} (copy)`;let number=2;while(data.posts.some(item=>item.title===title)){title=`${base} (copy ${number++})`;}const copy={...post,id:`post-${crypto.randomUUID()}`,title,status:'Draft' as const,date:new Date().toISOString(),opens:0,clicks:0};updateData(previous=>({...previous,posts:[copy,...previous.posts]}));setPostMenu(null);notify('Post duplicated. Make it your own.');};
  const schedulePost=()=>{
    if(!draft?.title.trim()){notify('Add a title before scheduling your post.');return;}
    const sendAt=new Date(scheduleDate);
    if(!Number.isFinite(sendAt.getTime())||sendAt<=new Date()){notify('Choose a date and time in the future.');return;}
    if(abTest&&!draft.subjectB?.trim()){notify('Add a second subject line or turn off the A/B test.');return;}
    const scheduled={...draft,content:clean(draft.content),status:'Scheduled' as const,date:sendAt.toISOString()};
    patch(scheduled);updateData(previous=>({...previous,posts:previous.posts.map(post=>post.id===scheduled.id?scheduled:post)}));setSchedule(false);notify(`Post scheduled for ${formatDate(scheduleDate)} at ${formatTime(scheduleDate)}. No live emails will be sent in this demo.`);
  };
  const filtered=data.posts.filter(post=>(status==='All posts'||post.status===status)&&`${post.title} ${post.subtitle}`.toLowerCase().includes(search.toLowerCase()));
  const text=draft?.content.replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').trim()||'';
  const words=text?text.split(/\s+/).length:0;
  const emailSize=Math.max(1,Math.round((new Blob([draft?.content||'']).size+4600)/1024));
  const activeReaders=data.subscribers.filter(sub=>sub.status==='Active'&&(!draft||draft.audience==='All subscribers'||sub.tier===draft.audience.replace(' subscribers',''))).length;
  let previewHtml=clean((draft?.content||'').replaceAll('{{first_name}}',previewPerson).replaceAll('{{publication_name}}',data.publication.name));
  if(previewMode==='Email')previewHtml=previewHtml.replace(/<(video|iframe|audio)[\s\S]*?<\/\1>/gi,'');

  if(draft)return <div className="posts-editor-page">
    <div className="editor-topbar"><button className="btn btn-secondary editor-back" onClick={backToPosts}><ArrowLeft size={16}/>Posts</button><span className="editor-breadcrumb">{draft.title||'Untitled post'}</span><span className="editor-save"><CheckCheck size={14}/>{saved?'All changes saved':'Saving…'}</span><button className="btn btn-secondary" onClick={()=>setPreview(true)}><Eye size={15}/>Preview</button><button className="btn btn-primary" onClick={()=>setSchedule(true)}>Continue<ArrowUpRight size={15}/></button></div>
    <div className="editor-heading-row"><div><div className="eyebrow">MAKE SOMETHING WORTH OPENING</div><h1 className="page-heading">A good story starts here.</h1></div><button className={`btn btn-secondary ${settings?'is-selected':''}`} onClick={()=>setSettings(!settings)}><Settings2 size={16}/>Post settings</button></div>
    <div className="editor-workspace">
      <main className="editor-sheet card">
        <div className="editor-formatbar"><div className="editor-format-group"><button title="Heading" onMouseDown={event=>event.preventDefault()} onClick={()=>command('formatBlock','h2')}><Heading2 size={17}/></button><button title="Bold (⌘B)" onMouseDown={event=>event.preventDefault()} onClick={()=>command('bold')}><Bold size={16}/></button><button title="Italic (⌘I)" onMouseDown={event=>event.preventDefault()} onClick={()=>command('italic')}><Italic size={16}/></button><button title="Underline (⌘U)" onMouseDown={event=>event.preventDefault()} onClick={()=>command('underline')}><Underline size={16}/></button></div><span className="toolbar-divider"/><div className="editor-format-group"><button title="Bulleted list" onMouseDown={event=>event.preventDefault()} onClick={()=>command('insertUnorderedList')}><List size={17}/></button><button title="Blockquote" onMouseDown={event=>event.preventDefault()} onClick={()=>command('formatBlock','blockquote')}><Quote size={16}/></button><button title="Add a link" onMouseDown={event=>event.preventDefault()} onClick={()=>{setAssetModal('link');setAssetUrl('');setAssetLabel('Read more');}}><Link2 size={17}/></button><button title="Insert an image" onMouseDown={event=>event.preventDefault()} onClick={()=>{setAssetModal('image');setAssetUrl('');setAssetLabel('Image description');}}><ImagePlus size={17}/></button></div><span className="toolbar-divider"/><button className="insert-block-btn" onMouseDown={event=>event.preventDefault()} onClick={()=>setBlockMenu(!blockMenu)}><Plus size={16}/>Insert<ChevronDown size={12}/></button><span className="toolbar-spacer"/><span className={`badge post-badge ${draft.status.toLowerCase()}`}>{draft.status}</span></div>
        <div className="editor-writing-area"><div className="editor-publication"><span className="publication-monogram">db.</span><div><strong>{data.publication.name}</strong><span>By Alex Morgan</span></div><span className="editor-reading-time">{Math.max(1,Math.ceil(words/200))} min read</span></div>
          <textarea className="post-title-input" aria-label="Post title" placeholder="Give your story a title…" rows={2} value={draft.title} onChange={event=>patch({title:event.target.value})}/>
          <input className="post-subtitle-input" aria-label="Post subtitle" placeholder="A little preview of what’s inside" value={draft.subtitle} onChange={event=>patch({subtitle:event.target.value})}/>
          <div className="editor-author-line"><span>AM</span><strong>Alex Morgan</strong><i>·</i><span>{formatDate(draft.date)}</span></div>
          <div ref={editor} className="rich-editor" contentEditable suppressContentEditableWarning role="textbox" aria-label="Newsletter content" aria-multiline="true" data-placeholder="Your next great idea goes here. Type / to add a block." onInput={syncEditor} onMouseUp={rememberSelection} onKeyUp={rememberSelection} onKeyDown={event=>{if(event.key==='/'&&isSlashCommandPosition()){event.preventDefault();rememberSelection();setBlockMenu(true);}}} onPaste={event=>{const html=event.clipboardData.getData('text/html');if(html){event.preventDefault();insert(html);}}}/>
          <button className="editor-add-block" onMouseDown={event=>event.preventDefault()} onClick={()=>{editor.current?.focus();rememberSelection();setBlockMenu(!blockMenu);}}><Plus size={15}/>Add a block<span>or type /</span></button>
        </div>
        <div className="editor-bottomline"><span>{words} words<span>·</span>{Math.max(1,Math.ceil(words/200))} min read</span><span className={emailSize>90?'size-warning':''}><span className="email-size-dot"/>{emailSize} KB / 102 KB<Mail size={13}/></span></div>
        {blockMenu&&<div className="block-menu card"><div className="block-menu-header"><strong>Add to your story</strong><button className="icon-btn" aria-label="Close block menu" onClick={()=>setBlockMenu(false)}><X size={14}/></button></div>{blocks.map(block=><button key={block.label} onMouseDown={event=>event.preventDefault()} onClick={()=>chooseBlock(block)}><span className="block-icon"><block.icon size={18}/></span><span><strong>{block.label}</strong><small>{block.detail}</small></span><ChevronRight size={13}/></button>)}</div>}
      </main>
      <aside className="editor-side-panel"><div className="card editor-side-card"><span className="editor-tip-icon"><Sparkles size={20}/></span><h3>A little inspiration?</h3><p>Your readers subscribed for your perspective. Start with something only you can say.</p><div className="editor-tip-rule"/><small>THE WRITER’S TOOLKIT</small><button onClick={()=>insert('<p>Hey {{first_name}},</p>')}><Users size={15}/>Make it personal<Plus size={14}/></button><button onClick={()=>chooseBlock(blocks[3])}><Quote size={15}/>Share a favorite quote<Plus size={14}/></button><button onClick={()=>setBlockMenu(true)}><Plus size={15}/>Explore all blocks<ChevronRight size={14}/></button></div>
        <div className="editor-checklist"><h4>Before you hit send</h4><p><Check size={14}/>A subject that sparks curiosity</p><p><Check size={14}/>One clear call to action</p><p><Check size={14}/>A quick preview in the inbox</p></div>
        {settings&&<div className="card editor-settings"><h3>Post settings</h3><label className="form-field">Audience<select className="field" value={draft.audience} onChange={event=>patch({audience:event.target.value})}><option>All subscribers</option><option>Free subscribers</option><option>Premium subscribers</option></select></label><label className="form-field">Cover image URL<input className="field" value={draft.image} onChange={event=>patch({image:event.target.value})} placeholder="https://…"/></label><button className="btn btn-secondary" onClick={()=>setPreview(true)}><Eye size={14}/>Preview personalization</button></div>}
      </aside>
    </div>
    {preview&&<div className="modal-backdrop post-modal-backdrop" onClick={()=>setPreview(false)}><div className="modal post-preview-modal" role="dialog" aria-modal="true" aria-label="Post preview" onClick={event=>event.stopPropagation()}><div className="post-modal-header"><div><h2>A little sneak peek</h2><p>See your story the way your readers will.</p></div><button className="icon-btn" aria-label="Close preview" onClick={()=>setPreview(false)}><X size={20}/></button></div><div className="preview-options"><div className="tabs">{(['Email','Website'] as const).map(mode=><button key={mode} className={`tab ${previewMode===mode?'active':''}`} onClick={()=>setPreviewMode(mode)}>{mode}</button>)}</div><label>Preview as<select value={previewPerson} onChange={event=>setPreviewPerson(event.target.value)}>{data.subscribers.slice(0,6).map(person=><option key={person.id} value={person.name.split(' ')[0]}>{person.name}</option>)}</select></label></div><div className="preview-scroll">{previewMode==='Email'&&<div className="email-envelope"><span><strong>From</strong>{data.publication.name} &lt;{data.publication.sender}&gt;</span><span><strong>Subject</strong>{draft.title||'Untitled post'}</span></div>}<article className="newsletter-preview"><div className="preview-brand">{data.publication.name}</div><h1>{draft.title||'Untitled post'}</h1><p className="preview-subtitle">{draft.subtitle}</p><div className="preview-author">Alex Morgan · {formatDate(draft.date)}</div>{draft.image&&<img className="preview-cover" src={draft.image} alt={draft.title}/>}<div className="rich-editor preview-content" dangerouslySetInnerHTML={{__html:previewHtml}}/><footer>You’re receiving this because you subscribed to {data.publication.name}.<br/><span>Manage your preferences</span> · <span>Unsubscribe</span></footer></article></div></div></div>}
    {schedule&&<div className="modal-backdrop" onClick={()=>setSchedule(false)}><div className="modal schedule-modal" role="dialog" aria-modal="true" aria-label="Schedule post" onClick={event=>event.stopPropagation()}><div className="post-modal-header"><div><span className="eyebrow">ONE LAST LOOK</span><h2>Ready for the inbox?</h2><p>Good stories deserve a thoughtful send.</p></div><button className="icon-btn" aria-label="Close scheduling" onClick={()=>setSchedule(false)}><X size={20}/></button></div><label className="form-field">Subject line<input className="field" value={draft.title} placeholder="An irresistible subject line" onChange={event=>patch({title:event.target.value})}/></label><label className="ab-toggle"><input type="checkbox" checked={abTest} onChange={event=>{setAbTest(event.target.checked);if(!event.target.checked)patch({subjectB:undefined});}}/><span>Test a second subject line</span><span className="badge">A/B test</span></label>{abTest&&<label className="form-field">Subject line B<input className="field" value={draft.subjectB||''} placeholder="Try a different approach" onChange={event=>patch({subjectB:event.target.value})}/><small>Preview a 50/50 split in this demo.</small></label>}<div className="schedule-form-grid"><label className="form-field">Send to<select className="field" value={draft.audience} onChange={event=>patch({audience:event.target.value})}><option>All subscribers</option><option>Free subscribers</option><option>Premium subscribers</option></select></label><label className="form-field">Date & time<input className="field" type="datetime-local" value={scheduleDate} onChange={event=>setScheduleDate(event.target.value)}/></label></div><div className="schedule-summary"><div><span><Users size={17}/></span><p><strong>{activeReaders} subscribers</strong><small>{draft.audience}</small></p></div><span className="badge"><Check size={12}/>Ready to go</span></div><p className="schedule-demo-note">Demo workspace · Scheduling saves your post here. Email delivery is not connected.</p><div className="post-modal-actions"><button className="btn btn-secondary" onClick={()=>{setSchedule(false);setPreview(true);}}><Eye size={15}/>Preview</button><button className="btn btn-primary" onClick={schedulePost}><Clock3 size={15}/>Schedule post</button></div></div></div>}
    {assetModal&&<div className="modal-backdrop" onClick={()=>setAssetModal(null)}><div className="modal post-asset-modal" role="dialog" aria-modal="true" aria-label="Insert media or link" onClick={event=>event.stopPropagation()}><div className="post-modal-header"><h2>{assetModal==='image'?'A picture tells a story':'Add a link'}</h2><button className="icon-btn" aria-label="Close insert dialog" onClick={()=>setAssetModal(null)}><X size={20}/></button></div><label className="form-field">{assetModal==='image'?'Image URL':'Destination URL'}<input autoFocus className="field" value={assetUrl} onChange={event=>setAssetUrl(event.target.value)} placeholder="https://…"/></label><label className="form-field">{assetModal==='image'?'Alt text':'Link text'}<input className="field" value={assetLabel} onChange={event=>setAssetLabel(event.target.value)}/></label>{assetModal==='image'&&<div className="image-library"><small>FROM YOUR MEDIA LIBRARY</small><div>{['habits','focus','ideas','sunday'].map(name=><button key={name} className={assetUrl===`/images/${name}.jpg`?'selected':''} onClick={()=>{setAssetUrl(`/images/${name}.jpg`);setAssetLabel(`${name.charAt(0).toUpperCase()}${name.slice(1)} newsletter illustration`);}}><img src={`/images/${name}.jpg`} alt={name}/></button>)}</div></div>}<div className="post-modal-actions"><button className="btn btn-secondary" onClick={()=>setAssetModal(null)}>Cancel</button><button className="btn btn-primary" onClick={addAsset}>Insert {assetModal}<Plus size={15}/></button></div></div></div>}
  </div>;

  return <div className="posts-page"><div className="posts-page-heading"><div><div className="eyebrow">YOUR WORDS, OUT IN THE WORLD</div><h1 className="page-heading">Posts</h1><p className="muted">Big ideas. Little updates. A home for every story.</p></div><button className="btn btn-primary" onClick={newDraft}><Plus size={16}/>Write a post</button></div>
    <div className="posts-stat-grid"><div className="card posts-mini-stat"><span className="posts-stat-icon"><FileText size={18}/></span><div><span>Total posts</span><strong>{data.posts.length}</strong></div><span className="stat-note">Keep the good ideas coming</span></div><div className="card posts-mini-stat"><span className="posts-stat-icon pink"><Send size={18}/></span><div><span>Published</span><strong>{data.posts.filter(post=>post.status==='Published').length}</strong></div><span className="stat-note">Out in the world</span></div><div className="card posts-mini-stat"><span className="posts-stat-icon lavender"><Clock3 size={18}/></span><div><span>In the works</span><strong>{data.posts.filter(post=>post.status!=='Published').length}</strong></div><span className="stat-note">Something good is coming</span></div></div>
    <section className="card posts-list-card"><div className="posts-list-controls"><div className="tabs">{['All posts','Published','Draft','Scheduled'].map(tab=><button key={tab} onClick={()=>setStatus(tab)} className={`tab ${status===tab?'active':''}`}>{tab}<span>{tab==='All posts'?data.posts.length:data.posts.filter(post=>post.status===tab).length}</span></button>)}</div><label className="posts-search"><Search size={15}/><input aria-label="Search posts" placeholder="Search your posts…" value={search} onChange={event=>setSearch(event.target.value)}/></label></div>
      <div className="posts-table-wrap"><table className="posts-table"><thead><tr><th>Post</th><th>Status</th><th>Date<ChevronDown size={12}/></th><th>Open rate</th><th>Click rate</th><th/></tr></thead><tbody>{filtered.map(post=><tr key={post.id}><td><button className="post-cell" onClick={()=>openDraft(post)}>{post.image?<img src={post.image} alt=""/>:<span className="post-thumbnail-empty"><FileText size={24}/></span>}<span><strong>{post.title||'Untitled post'}</strong><small>{post.subtitle||'A fresh page. A new possibility.'}</small></span></button></td><td><span className={`badge post-badge ${post.status.toLowerCase()}`}><span/>{post.status}</span></td><td className="post-date-cell">{formatDate(post.date)}<small>{post.status==='Scheduled'?`Scheduled for ${formatTime(post.date)}`:post.status==='Draft'?`Edited at ${formatTime(post.date)}`:`Sent at ${formatTime(post.date)}`}</small></td><td>{post.status==='Published'?`${post.opens}%`:'—'}</td><td>{post.status==='Published'?`${post.clicks}%`:'—'}</td><td className="post-actions"><button className="icon-btn" aria-label={`Options for ${post.title||'Untitled post'}`} onClick={()=>setPostMenu(postMenu===post.id?null:post.id)}><MoreHorizontal size={20}/></button>{postMenu===post.id&&<div className="post-row-menu card"><button onClick={()=>{openDraft(post);setPostMenu(null);}}><FileText size={14}/>Open post</button><button onClick={()=>duplicate(post)}><Copy size={14}/>Duplicate</button><button onClick={()=>{openDraft(post);setPreview(true);setPostMenu(null);}}><Eye size={14}/>Preview</button>{post.status==='Scheduled'&&<button onClick={()=>{updateData(previous=>({...previous,posts:previous.posts.map(item=>item.id===post.id?{...item,status:'Draft'}:item)}));setPostMenu(null);notify('Post moved back to drafts.');}}><Clock3 size={14}/>Unschedule</button>}</div>}</td></tr>)}</tbody></table></div>
      {!filtered.length&&<div className="empty-state"><FileText size={32}/><h3>{search?'No stories match that search.':'Your next chapter starts here.'}</h3><p>{search?'Try another title or clear your filters.':'Put a good idea on the page and make it yours.'}</p><button className="btn btn-secondary" onClick={()=>search?setSearch(''):newDraft()}>{search?'Clear search':'Write a post'}</button></div>}
      <div className="posts-list-footer"><span>Showing {filtered.length} of {data.posts.length} posts</span><span>A little inspiration goes a long way.<Sparkles size={13}/></span></div>
    </section><div className="posts-bottom-note"><span><Mail size={17}/></span><p>Make every send feel personal.<br/><small>Use merge tags, your own voice, and a little curiosity.</small></p><button onClick={newDraft}>Start writing<ArrowUpRight size={15}/></button></div>
  </div>;
}
