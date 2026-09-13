(function (root) {
  'use strict';
  function element(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }
  function button(label, className, action) {
    const node = element('button', 'cx-button ' + (className || ''), label); node.type = 'button';
    if (action) node.addEventListener('click', action); return node;
  }
  function mount(container, { decision, bridge, compact = false, dialogHost = container }) {
    if (!container || !bridge || typeof bridge.preview !== 'function' || typeof bridge.save !== 'function') throw new TypeError('缺少反馈接口');
    let current = decision, generation = 0, disposed = false, previewId = null, actionBusy = false, surveyBusy = false, opener = null;
    const panel = element('section', 'cx-panel' + (compact ? ' cx-compact' : ''));
    const notice = element('p', 'cx-notice'); notice.setAttribute('role','status'); notice.setAttribute('aria-live','polite');
    const dialog = element('dialog', 'cx-dialog'); dialog.setAttribute('aria-label','本次兼容反馈');
    const dialogBody = element('div', 'cx-dialog-body'); dialog.append(dialogBody);
    container.append(panel,notice); dialogHost.append(dialog);
    function announce(message) { if (!disposed) notice.textContent = message; }
    function dropPreview() {
      if (previewId && typeof bridge.discard === 'function') Promise.resolve(bridge.discard(previewId)).catch(()=>{});
      previewId = null;
    }
    function close() {
      generation++; surveyBusy = false; dropPreview();
      if (dialog.open) dialog.close();
      if (typeof bridge.close === 'function') Promise.resolve().then(() => bridge.close()).catch(() => {});
      if (opener?.isConnected) opener.focus();
    }
    dialog.addEventListener('cancel', event => { if (surveyBusy) { event.preventDefault(); return; } event.preventDefault(); close(); });
    function render() {
      const wasOpen = panel.querySelector('details')?.open === true;
      panel.replaceChildren();
      const top = element('div','cx-top');
      const title = element('div'); title.append(element('p','cx-eyebrow',current?.subtitle || '当前方案'),element('h3','',current?.title || '等待游戏信息'));
      top.append(title); panel.append(top,element('p','cx-status',current?.status || '尚未取得状态'));
      const reasons = current?.reasons || [];
      if (reasons.length) panel.append(element('p','cx-reasons',reasons.join(' · ')));
      for (const warning of current?.warnings || []) panel.append(element('p','cx-warning',warning));
      const actions = element('div','cx-actions');
      if (current?.primary && typeof bridge.primary === 'function') {
        const primary = button(actionBusy?'处理中…':current.primary.label,'cx-primary',async()=>{
          if (actionBusy) return; actionBusy=true;const key=current.contextKey;const action={...current.primary};render();
          try {
            await bridge.primary(action); // Host still performs its existing frozen-plan checks/confirmation.
            if (!disposed && current.contextKey === key) announce('操作已交给现有安装流程；运行效果需单独确认。');
          } catch(e) { if (!disposed && current.contextKey===key) announce(e.message || '操作未完成，请查看原安装流程。'); }
          finally {actionBusy=false;if(!disposed)render();}
        });
        primary.disabled=actionBusy;actions.append(primary);
      }
      const reportButton=button('反馈本次体验','',()=>openSurvey(reportButton));reportButton.disabled=!current?.contextKey||actionBusy||current?.feedbackDisabled===true;
      actions.append(reportButton);panel.append(actions);
      const more=element('details','cx-more');more.open=wasOpen;
      more.append(element('summary','','查看组件与其他方案'));
      more.append(element('p','cx-hint',current?.verification || '尚无匹配的实际游戏验证'));
      const dl=element('dl','cx-layer-list');
      for(const layer of current?.layers||[]){dl.append(element('dt','',layer.label),element('dd','',[layer.name,layer.version].filter(Boolean).join(' · ')));}more.append(dl);
      for(const route of current?.alternatives||[]){
        const item=element('div','cx-alternative');item.append(element('strong','',route.name),element('p','cx-hint',route.reason));
        if(typeof bridge.chooseRecipe==='function'){
          const choose=button('查看切换方案','',async()=>{
            if(actionBusy)return;actionBusy=true;choose.disabled=true;
            try{await bridge.chooseRecipe(route.id);}catch(e){announce(e.message||'无法检查该方案');}finally{actionBusy=false;choose.disabled=!route.available;}
          });choose.disabled=!route.available;item.append(choose);
        }more.append(item);
      }
      if (!compact || (current?.layers || []).length || (current?.alternatives || []).length) panel.append(more);
    }
    function fieldset(title,name,options,selected='unknown'){
      const group=element('fieldset','cx-rating');group.append(element('legend','',title));
      const row=element('div','cx-choices');
      for(const[value,label]of options){const control=element('label','cx-choice'),radio=document.createElement('input');
        radio.type='radio';radio.name=name;radio.value=value;radio.checked=value===selected;control.append(radio,element('span','',label));row.append(control);}
      group.append(row);return group;
    }
    function openSurvey(source){
      if(!current?.contextKey||current?.feedbackDisabled===true||surveyBusy)return;
      opener=source;generation++;notice.textContent='';dropPreview();renderSurvey();dialog.showModal();dialog.querySelector('h2')?.focus();
    }
    function renderSurvey(draft={}){
      dialogBody.replaceChildren();
      const heading=element('div','cx-dialog-heading'),h=element('h2','','本次体验怎么样？');h.tabIndex=-1;
      const closeButton=button('关闭','cx-quiet',close);heading.append(h,closeButton);dialogBody.append(heading);
      if(current?.gameName)dialogBody.append(element('p','cx-context-game',current.gameName));
      dialogBody.append(element('p','cx-hint','版本、驱动和运行记录由程序填写。不确定的项目可以跳过。'));
      const form=element('form','cx-survey');form.addEventListener('submit',e=>e.preventDefault());
      form.append(fieldset('能正常玩吗？','playability',[['normal','正常'],['cannot-start','无法启动'],['crash-or-freeze','闪退 / 卡死'],['unknown','不确定']],draft.playability));
      const image=fieldset('画面表现如何？','image',[['improved','有改善'],['unchanged','没变化'],['artifacts','有异常'],['unknown','不确定']],draft.image);form.append(image);
      const tags=element('div','cx-tags');tags.hidden=draft.image!=='artifacts';
      for(const[value,label]of [['flicker','闪烁'],['ghosting','拖影'],['brightness','亮度异常'],['hud','界面异常'],['other','其他']]){
        const l=element('label','cx-check'),i=document.createElement('input');i.type='checkbox';i.name='tags';i.value=value;i.checked=(draft.tags||[]).includes(value);l.append(i,element('span','',label));tags.append(l);
      }image.addEventListener('change',()=>{tags.hidden=new FormData(form).get('image')!=='artifacts';});form.append(tags);
      form.append(fieldset('流畅度能接受吗？','fluidity',[['smooth','流畅'],['acceptable','勉强可用'],['unacceptable','不能接受'],['unknown','不确定']],draft.fluidity));
      const label=element('label','cx-note-label','补充一句（可选）'),note=element('textarea','cx-note');note.name='note';note.maxLength=600;note.rows=3;note.value=draft.note||'';
      note.placeholder='例如：读档后开始闪烁，切回原版就正常。';label.append(note);form.append(label);
      const logLabel=element('label','cx-check cx-log-choice'),logs=document.createElement('input');logs.type='checkbox';logs.name='includeLogs';logs.checked=draft.includeLogs===true;
      logLabel.append(logs,element('span','','附带相关诊断日志（先预览，可能含隐私）'));form.append(logLabel);
      const error=element('p','cx-error');error.setAttribute('role','alert');form.append(error);
      const footer=element('div','cx-footer'),skip=button('暂时不反馈','cx-quiet',close);
      const prepare=button('预览反馈包','cx-primary',async()=>{
        if(surveyBusy)return;surveyBusy=true;const mine=generation;
        const data=new FormData(form);const ratings={playability:data.get('playability')||'unknown',image:data.get('image')||'unknown',fluidity:data.get('fluidity')||'unknown',tags:data.getAll('tags'),note:data.get('note')||''};
        const includeLogs=logs.checked;
        for(const control of dialogBody.querySelectorAll('button,input,textarea'))control.disabled=true;
        prepare.textContent='正在整理…';error.textContent='';
        try{
          const preview=await bridge.preview({ratings,includeLogs});
          if(disposed||mine!==generation){if(preview?.previewId&&bridge.discard)Promise.resolve(bridge.discard(preview.previewId)).catch(()=>{});return;}
          previewId=preview.previewId;renderPreview(preview,{...ratings,includeLogs});
        }catch(e){if(!disposed&&mine===generation){error.textContent=e.message||'反馈整理失败，可稍后重试。';for(const control of dialogBody.querySelectorAll('button,input,textarea'))control.disabled=false;prepare.textContent='预览反馈包';}}
        finally{if(mine===generation)surveyBusy=false;}
      });footer.append(skip,prepare);form.append(footer);dialogBody.append(form);
    }
    function renderPreview(preview,draft){
      dialogBody.replaceChildren();const heading=element('div','cx-dialog-heading');heading.append(element('h2','','确认后保存到本地'),button('关闭','cx-quiet',close));dialogBody.append(heading);
      dialogBody.append(element('p','cx-hint','不会自动上传。保存后，把 ZIP 发给测试群管理员即可。'));
      const summary=element('pre','cx-summary',preview.summary);dialogBody.append(summary);
      const files=element('details','cx-more');files.append(element('summary','',`查看将打包的内容（${preview.files?.length||0} 项）`));
      const meta=element('details','cx-more');meta.append(element('summary','','查看自动收集的完整信息'),element('pre','cx-summary',JSON.stringify(preview.report,null,2)));files.append(meta);
      for(const row of preview.files||[])files.append(element('p','cx-hint',`${row.path} · ${row.bytes} 字节${row.scope==='historical'?' · 历史附件，不证明本次运行':''}`));
      for(const log of preview.logPreview||[]){const d=element('details','cx-more');d.append(element('summary','',log.name),element('pre','cx-log',log.text));files.append(d);}dialogBody.append(files);
      dialogBody.append(element('p','cx-hint',preview.privacyWarning));
      const error=element('p','cx-error');error.setAttribute('role','alert');dialogBody.append(error);
      const footer=element('div','cx-footer'),back=button('返回修改','',()=>{dropPreview();renderSurvey(draft);});
      const save=button('确认并保存反馈包','cx-primary',async()=>{
        if(surveyBusy)return;surveyBusy=true;const mine=generation,id=previewId;
        for(const b of dialogBody.querySelectorAll('button'))b.disabled=true;save.textContent='正在保存…';
        try{
          const result=await bridge.save({previewId:id,confirmed:true});
          if(disposed||mine!==generation)return;
          if(result?.cancelled){for(const b of dialogBody.querySelectorAll('button'))b.disabled=false;save.textContent='确认并保存反馈包';return;}
          if(result?.saved!==true)throw new Error('没有取得保存结果，请重试。');
          previewId=null;close();announce('反馈包已保存。请将 ZIP 发给测试群管理员。');
        }catch(e){if(!disposed&&mine===generation){error.textContent=e.message||'保存失败，请重试。';for(const b of dialogBody.querySelectorAll('button'))b.disabled=false;save.textContent='确认并保存反馈包';}}
        finally{if(mine===generation)surveyBusy=false;}
      });footer.append(back,save);dialogBody.append(footer);
    }
    render();
    return {
      openFeedback(){openSurvey(panel.querySelector('.cx-actions button:last-child'));},
      closeFeedback: close,
      update(next){if(disposed)return;if(next.contextKey!==current?.contextKey){close();announce('已切换游戏，旧反馈预览已关闭。');}current=next;render();},
      destroy(){disposed=true;close();panel.remove();notice.remove();dialog.remove();}
    };
  }
  root.ManagerCompatibilityUX=Object.freeze({mount});
})(typeof window!=='undefined'?window:globalThis);
