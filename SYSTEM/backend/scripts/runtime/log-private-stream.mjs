import {StringDecoder} from 'node:string_decoder';
import {privateLine} from './log-privacy.mjs';

// Raw chunks live only until a complete line is available. The context ring
// always contains projected technical data, never the original output.
export function createPrivateErrorStream(write) {
 let before=[],left=0,sequence=0,persisted=0;
 const emit=(raw,over=false)=>{
  const entry={number:++sequence,line:privateLine(over?'':raw)};
  const persist=item=>{if(item.number>persisted){write(item.line+'\n');persisted=item.number;}};
  const error=over||(!/\b(?:DeprecationWarning|ExperimentalWarning|Warning):/.test(raw)&&/(?:\b(?:ERROR|CRITICAL)\b|\b[A-Za-z]*Error:|"ok"\s*:\s*false|"status"\s*:\s*"(?:error|failed)")/.test(raw));
  if(error){before.forEach(persist);persist(entry);left=5;}
  else if(left){persist(entry);left--;}
  before.push(entry);if(before.length>5)before.shift();
 };
 function channel(){
  const decoder=new StringDecoder('utf8');let pending='',over=false;
  const feed=text=>{for(const char of text){if(char==='\n'){emit(pending,over);pending='';over=false;}else if(!over){pending+=char;if(pending.length>512*1024){pending='';over=true;}}}};
  return {write(chunk){feed(typeof chunk==='string'?chunk:decoder.write(chunk));},end(){feed(decoder.end());if(pending||over)emit(pending,over);pending='';over=false;}};
 }
 return {channel};
}
