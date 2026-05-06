msg.headers = { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" };
msg.payload = `(function(){
  const panelId='cameraFloatingPanel';
  const styleId='cameraFloatingPanelStyle';
  const modeSingle='single';
  const modeTile='tile';
  const streamConnectTimeoutMs=3000;
  const directReconnectDelayMs=1200;
  const proxyReconnectDelayMs=1500;
  const maxDirectReconnectAttempts=2;
  const maxProxyReconnectAttempts=3;
  const maxInitialProxyErrorsBeforeDirect=2;
  let panelOpen=false;
  let mode=modeSingle;
  let cameras=[];
  let activeCameraId='';
  let singleConfig=null;
  let fallbackTimer=null;
  let streamStageTimer=null;
  let directReconnectTimer=null;
  let proxyReconnectTimer=null;
  let tileTimers={};
  let streamState={
    hasEverLoadedStream:false,
    currentTransport:'',
    currentCaptureUrl:'',
    consecutiveDirectErrors:0,
    consecutiveProxyErrors:0,
    requestId:0
  };

  function addStyle(){
    if(document.getElementById(styleId)) return;
    const style=document.createElement('style');
    style.id=styleId;
    style.textContent='\
#cameraFloatingPanel{position:absolute;top:54px;right:10px;z-index:1200;width:620px;height:420px;min-width:360px;min-height:260px;background:#fff;border:1px solid #cfd8dc;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.28);display:none;overflow:hidden;}\
#cameraFloatingPanel.open{display:flex;flex-direction:column;}\
#cameraFloatingPanel .head{display:flex;gap:8px;align-items:center;padding:8px 10px;background:#f4f7fb;border-bottom:1px solid #d9e1e8;cursor:move;}\
#cameraFloatingPanel .head button,#cameraFloatingPanel .head select{border:1px solid #b8c5d1;background:#fff;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;}\
#cameraFloatingPanel .head .spacer{margin-left:auto;}\
#cameraFloatingPanel .body{position:relative;flex:1;min-height:0;background:#000;touch-action:none;}\
#cameraFloatingPanel .resize-handle{position:absolute;z-index:25;background:transparent;}\
#cameraFloatingPanel .resize-handle.handle-e{top:0;right:0;bottom:0;width:12px;cursor:e-resize;}\
#cameraFloatingPanel .resize-handle.handle-w{top:0;left:0;bottom:0;width:12px;cursor:w-resize;}\
#cameraFloatingPanel .resize-handle.handle-n{top:0;left:0;right:0;height:12px;cursor:n-resize;}\
#cameraFloatingPanel .resize-handle.handle-s{bottom:0;left:0;right:0;height:12px;cursor:s-resize;}\
#cameraFloatingPanel .single,#cameraFloatingPanel .tiles{display:none;height:100%;}#cameraFloatingPanel .single.active{display:block;}#cameraFloatingPanel .tiles.active{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;padding:8px;overflow:auto;background:#101010;}\
#cameraFloatingPanel .single img{width:100%;height:100%;object-fit:contain;background:#000;transform-origin:center center;cursor:default;}\
#cameraFloatingPanel .badge{position:absolute;left:10px;bottom:10px;color:#fff;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:6px;font-size:11px;}\
#cameraFloatingPanel .empty{display:flex;align-items:center;justify-content:center;height:100%;color:#c7d0d7;font-size:13px;}\
#cameraFloatingPanel .camera-modal{position:absolute;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;z-index:30;}\
#cameraFloatingPanel .camera-modal.open{display:flex;}\
#cameraFloatingPanel .camera-modal-card{width:320px;background:#fff;border-radius:8px;padding:12px;box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:8px;}\
#cameraFloatingPanel .camera-modal-card input{padding:7px 8px;border:1px solid #c4d0da;border-radius:6px;font-size:12px;}\
#cameraFloatingPanel .camera-modal-actions{display:flex;justify-content:flex-end;gap:8px;}\
#cameraFloatingPanel .camera-manage-list{max-height:220px;overflow:auto;border:1px solid #d9e1e8;border-radius:6px;padding:8px;}\
#cameraFloatingPanel .camera-manage-item{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eef3f7;}\
#cameraFloatingPanel .camera-manage-item:last-child{border-bottom:0;}\
#cameraFloatingPanel .camera-manage-item .name{font-weight:bold;font-size:12px;}\
#cameraFloatingPanel .camera-manage-item .host{font-size:11px;color:#5d6b78;}\
#cameraFloatingPanel .tile{position:relative;min-height:160px;background:#000;border:1px solid #27313a;border-radius:8px;overflow:hidden;}\
#cameraFloatingPanel .tile img{width:100%;height:100%;object-fit:cover;}\
#cameraFloatingPanel .tile .title{position:absolute;left:6px;top:6px;color:#fff;background:rgba(0,0,0,.6);padding:3px 6px;border-radius:4px;font-size:11px;}';
    document.head.appendChild(style);
  }

  function formatTimestampForFileName() {
    const now = new Date();
    return now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
  }

  function parseJson(r){return r.json();}
  function loadRegistry(){return fetch('/api/cameras',{cache:'no-store'}).then(parseJson).then(function(j){if(!j||j.ok===false) throw new Error(j&&j.error?j.error:'Kameraliste konnte nicht geladen werden.');return j.data||{cameras:[],activeCameraId:''};});}
  function setActiveCamera(cameraId){return fetch('/api/cameras/active',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cameraId:cameraId||''})}).then(parseJson);}
  function addCamera(name,host){return fetch('/api/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:name,host:host})}).then(parseJson).then(function(j){if(!j||j.ok===false) throw new Error(j&&j.error?j.error:'Kamera konnte nicht hinzugefügt werden.');return j;});}
  function removeCamera(id){return fetch('/api/cameras/'+encodeURIComponent(id),{method:'DELETE'}).then(parseJson).then(function(j){if(!j||j.ok===false) throw new Error(j&&j.error?j.error:'Kamera konnte nicht gelöscht werden.');return j;});}
  function loadConfig(cameraId){const suffix=cameraId?('?cameraId='+encodeURIComponent(cameraId)):'';return fetch('/api/camera/config'+suffix,{cache:'no-store'}).then(parseJson).then(function(j){if(!j||j.ok===false||!j.data) throw new Error(j&&j.error?j.error:'Kamera-Konfiguration fehlt.');return j.data;});}

  function stopFallback(){if(fallbackTimer) clearTimeout(fallbackTimer);fallbackTimer=null;}
  function stopTileTimers(){Object.keys(tileTimers).forEach(function(id){clearTimeout(tileTimers[id]);});tileTimers={};}
  function stopStreamStageTimer(){if(streamStageTimer) clearTimeout(streamStageTimer);streamStageTimer=null;}
  function stopDirectReconnectTimer(){if(directReconnectTimer) clearTimeout(directReconnectTimer);directReconnectTimer=null;}
  function stopProxyReconnectTimer(){if(proxyReconnectTimer) clearTimeout(proxyReconnectTimer);proxyReconnectTimer=null;}
  function stopAllSingleTimers(){
    stopFallback();
    stopStreamStageTimer();
    stopDirectReconnectTimer();
    stopProxyReconnectTimer();
  }

  function mountPanel(){
    const toggle=document.getElementById('cameraToggleBtn');
    const host=document.getElementById('cameraPanelHost');
    if(!toggle||!host) return;
    addStyle();
    const panel=document.createElement('div');
    panel.id=panelId;
    panel.innerHTML='<div class="head"><select id="cameraSelect"></select><button id="cameraAddBtn" type="button">+</button><button id="cameraManageBtn" type="button">Liste</button><button id="cameraModeBtn" type="button" title="Einzel/Kachel">▣</button><span class="spacer"></span><button id="cameraSettingsBtn" type="button">Settings</button><button id="cameraRefreshBtn" type="button">Neu laden</button><button id="cameraScreenshotBtn" type="button">Screenshot</button></div><div class="resize-handle handle-e" data-resize-dir="e"></div><div class="resize-handle handle-w" data-resize-dir="w"></div><div class="resize-handle handle-n" data-resize-dir="n"></div><div class="resize-handle handle-s" data-resize-dir="s"></div><div class="body"><div id="singleView" class="single active"><img id="singleImage" alt="Camera" /><div id="singleBadge" class="badge" style="display:none"></div><div id="singleEmpty" class="empty" style="display:none">Keine Kamera ausgewählt.</div></div><div id="tilesView" class="tiles"></div><div id="cameraModal" class="camera-modal"></div></div>';
    host.appendChild(panel);

    const select=panel.querySelector('#cameraSelect');
    const addBtn=panel.querySelector('#cameraAddBtn');
    const manageBtn=panel.querySelector('#cameraManageBtn');
    const modeBtn=panel.querySelector('#cameraModeBtn');
    const settingsBtn=panel.querySelector('#cameraSettingsBtn');
    const refreshBtn=panel.querySelector('#cameraRefreshBtn');
    const screenshotBtn=panel.querySelector('#cameraScreenshotBtn');
    const singleView=panel.querySelector('#singleView');
    const tilesView=panel.querySelector('#tilesView');
    const singleImg=panel.querySelector('#singleImage');
    const singleBadge=panel.querySelector('#singleBadge');
    const singleEmpty=panel.querySelector('#singleEmpty');
    const modalElement=panel.querySelector('#cameraModal');
    let imageZoom=1;
    let imagePanX=0;
    let imagePanY=0;

    function renderSelect(){
      const parts=['<option value="">Kamera wählen</option>'];
      cameras.forEach(function(camera){parts.push('<option value="'+camera.id+'"'+(camera.id===activeCameraId?' selected':'')+'>'+camera.name+'</option>');});
      select.innerHTML=parts.join('');
    }

    function setBadge(text){singleBadge.style.display=text?'':'none';singleBadge.textContent=text||'';}
    function openModal(contentHtml){
      if(!modalElement) return;
      modalElement.innerHTML='<div class="camera-modal-card">'+contentHtml+'</div>';
      modalElement.classList.add('open');
    }
    function closeModal(){
      if(!modalElement) return;
      modalElement.classList.remove('open');
      modalElement.innerHTML='';
    }
    function openAddCameraDialog(){
      openModal([
        '<strong>Neue Kamera hinzufügen</strong>',
        '<input id="cameraInputName" placeholder="Name" maxlength="50" />',
        '<input id="cameraInputHost" placeholder="IP oder Hostname" maxlength="255" />',
        '<div class="camera-modal-actions">',
        '  <button id="cameraCancelAddBtn" type="button">Abbrechen</button>',
        '  <button id="cameraSaveAddBtn" type="button">Speichern</button>',
        '</div>'
      ].join(''));
      const nameInput=modalElement.querySelector('#cameraInputName');
      const hostInput=modalElement.querySelector('#cameraInputHost');
      const cancelButton=modalElement.querySelector('#cameraCancelAddBtn');
      const saveButton=modalElement.querySelector('#cameraSaveAddBtn');
      if(nameInput) nameInput.focus();
      function saveCamera(){
        const cameraName=String((nameInput&&nameInput.value)||'').trim();
        const cameraHost=String((hostInput&&hostInput.value)||'').trim();
        if(!cameraName||!cameraHost){
          window.alert('Name und IP/Host sind erforderlich.');
          return;
        }
        addCamera(cameraName,cameraHost).then(function(res){
          closeModal();
          return refreshRegistry(res&&res.data?res.data.activeCameraId:'');
        }).catch(function(error){
          window.alert(error&&error.message?error.message:'Kamera konnte nicht gespeichert werden.');
        });
      }
      if(cancelButton) cancelButton.addEventListener('click',closeModal);
      if(saveButton) saveButton.addEventListener('click',saveCamera);
      if(hostInput){
        hostInput.addEventListener('keydown',function(event){
          if(event.key==='Enter') saveCamera();
        });
      }
      if(nameInput){
        nameInput.addEventListener('keydown',function(event){
          if(event.key==='Enter'&&hostInput) hostInput.focus();
        });
      }
    }
    function openManageCameraDialog(){
      const listHtml=cameras.map(function(camera){
        return [
          '<div class="camera-manage-item" data-camera-id="'+camera.id+'">',
          '  <div style="flex:1;">',
          '    <div class="name">'+camera.name+'</div>',
          '    <div class="host">'+camera.host+'</div>',
          '  </div>',
          '  <button type="button" data-action="remove">Entfernen</button>',
          '</div>'
        ].join('');
      }).join('');
      openModal([
        '<strong>Kameras verwalten</strong>',
        '<div class="camera-manage-list">'+(listHtml||'<div class="empty">Keine Kameras vorhanden.</div>')+'</div>',
        '<div class="camera-modal-actions"><button id="cameraCloseManageBtn" type="button">Schließen</button></div>'
      ].join(''));
      const closeButton=modalElement.querySelector('#cameraCloseManageBtn');
      if(closeButton) closeButton.addEventListener('click',closeModal);
      Array.from(modalElement.querySelectorAll('[data-action="remove"]')).forEach(function(removeButton){
        removeButton.addEventListener('click',function(){
          const row=removeButton.closest('[data-camera-id]');
          const cameraId=row?row.getAttribute('data-camera-id'):'';
          if(!cameraId) return;
          removeCamera(cameraId).then(function(){
            closeModal();
            return refreshRegistry('');
          }).catch(function(error){
            window.alert(error&&error.message?error.message:'Kamera konnte nicht entfernt werden.');
          });
        });
      });
    }
    function applyImageTransform(){
      singleImg.style.transform='translate('+imagePanX+'px,'+imagePanY+'px) scale('+imageZoom+')';
      singleImg.style.cursor=imageZoom>1?'grab':'default';
    }
    function clampImagePan(){
      const viewRect=singleView.getBoundingClientRect();
      const maxPanX=Math.max(0,(viewRect.width*(imageZoom-1))/2);
      const maxPanY=Math.max(0,(viewRect.height*(imageZoom-1))/2);
      imagePanX=Math.max(-maxPanX,Math.min(maxPanX,imagePanX));
      imagePanY=Math.max(-maxPanY,Math.min(maxPanY,imagePanY));
    }
    function resetImageTransform(){
      imageZoom=1;
      imagePanX=0;
      imagePanY=0;
      applyImageTransform();
    }
    function attachImageZoomAndPan(){
      singleView.addEventListener('wheel',function(event){
        if(mode!==modeSingle||!panelOpen) return;
        event.preventDefault();
        const zoomDelta=event.deltaY<0?0.15:-0.15;
        imageZoom=Math.max(1,Math.min(10,imageZoom+zoomDelta));
        if(imageZoom===1){
          imagePanX=0;
          imagePanY=0;
        }else{
          clampImagePan();
        }
        applyImageTransform();
      },{ passive:false });
      singleView.addEventListener('pointerdown',function(event){
        if(mode!==modeSingle||imageZoom<=1) return;
        event.preventDefault();
        const startX=event.clientX;
        const startY=event.clientY;
        const startPanX=imagePanX;
        const startPanY=imagePanY;
        singleImg.style.cursor='grabbing';
        function onMove(moveEvent){
          imagePanX=startPanX+(moveEvent.clientX-startX);
          imagePanY=startPanY+(moveEvent.clientY-startY);
          clampImagePan();
          applyImageTransform();
        }
        function onUp(){
          singleImg.style.cursor=imageZoom>1?'grab':'default';
          document.removeEventListener('pointermove',onMove);
          document.removeEventListener('pointerup',onUp);
        }
        document.addEventListener('pointermove',onMove);
        document.addEventListener('pointerup',onUp);
      });
    }
    function attachPanelDrag(){
      const panelHeader=panel.querySelector('.head');
      if(!panelHeader) return;
      panelHeader.addEventListener('pointerdown',function(event){
        const target=event.target;
        if(target&&typeof target.closest==='function'&&target.closest('button,select')) return;
        event.preventDefault();
        const panelRect=panel.getBoundingClientRect();
        const startX=event.clientX;
        const startY=event.clientY;
        const startLeft=panelRect.left;
        const startTop=panelRect.top;
        panel.style.left=Math.round(startLeft)+'px';
        panel.style.top=Math.round(startTop)+'px';
        panel.style.right='auto';
        function onMove(moveEvent){
          const deltaX=moveEvent.clientX-startX;
          const deltaY=moveEvent.clientY-startY;
          const nextLeft=startLeft+deltaX;
          const nextTop=startTop+deltaY;
          panel.style.left=Math.round(nextLeft)+'px';
          panel.style.top=Math.round(nextTop)+'px';
        }
        function onUp(){
          document.removeEventListener('pointermove',onMove);
          document.removeEventListener('pointerup',onUp);
        }
        document.addEventListener('pointermove',onMove);
        document.addEventListener('pointerup',onUp);
      });
    }
    function attachEdgeResize(){
      const minWidth=360;
      const minHeight=260;
      const handles=Array.from(panel.querySelectorAll('.resize-handle'));
      handles.forEach(function(handle){
        const direction=handle.getAttribute('data-resize-dir')||'e';
        handle.addEventListener('pointerdown',function(event){
          event.preventDefault();
          const rect=panel.getBoundingClientRect();
          const startX=event.clientX;
          const startY=event.clientY;
          const startWidth=rect.width;
          const startHeight=rect.height;
          const startLeft=rect.left;
          const startTop=rect.top;
          panel.style.left=Math.round(startLeft)+'px';
          panel.style.top=Math.round(startTop)+'px';
          panel.style.right='auto';
          function onMove(moveEvent){
            const deltaX=moveEvent.clientX-startX;
            const deltaY=moveEvent.clientY-startY;
            let nextWidth=startWidth;
            let nextHeight=startHeight;
            let nextLeft=startLeft;
            let nextTop=startTop;
            if(direction.indexOf('e')>=0) nextWidth=startWidth+deltaX;
            if(direction.indexOf('w')>=0) nextWidth=startWidth-deltaX;
            if(direction.indexOf('s')>=0) nextHeight=startHeight+deltaY;
            if(direction.indexOf('n')>=0) nextHeight=startHeight-deltaY;
            nextWidth=Math.max(minWidth,nextWidth);
            nextHeight=Math.max(minHeight,nextHeight);
            if(direction.indexOf('w')>=0) nextLeft=startLeft+(startWidth-nextWidth);
            if(direction.indexOf('n')>=0) nextTop=startTop+(startHeight-nextHeight);
            panel.style.width=Math.round(nextWidth)+'px';
            panel.style.height=Math.round(nextHeight)+'px';
            panel.style.left=Math.round(nextLeft)+'px';
            panel.style.top=Math.round(nextTop)+'px';
          }
          function onUp(){
            document.removeEventListener('pointermove',onMove);
            document.removeEventListener('pointerup',onUp);
          }
          document.addEventListener('pointermove',onMove);
          document.addEventListener('pointerup',onUp);
        });
      });
    }

    function startCaptureLoop(captureUrl, badgeText, transportName, requestId){
      if(!panelOpen||!singleConfig||!captureUrl) return;
      if(typeof requestId==='number' && requestId!==streamState.requestId) return;
      streamState.currentTransport=transportName;
      streamState.currentCaptureUrl=captureUrl;
      setBadge(badgeText);
      singleImg.src=captureUrl+(captureUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();
      fallbackTimer=setTimeout(function(){
        startCaptureLoop(captureUrl, badgeText, transportName, requestId);
      }, Number(singleConfig.fallbackIntervalMs)>0?Number(singleConfig.fallbackIntervalMs):1200);
    }

    function startProxyCaptureFallback(cfg, requestId){
      if(!cfg) return;
      if(typeof requestId==='number' && requestId!==streamState.requestId) return;
      const proxyCaptureUrl = cfg.proxyCaptureUrl || cfg.captureUrl || '';
      if(!proxyCaptureUrl) return;
      stopStreamStageTimer();
      stopDirectReconnectTimer();
      stopProxyReconnectTimer();
      startCaptureLoop(proxyCaptureUrl, 'Fallback: Proxy-Capture', 'proxy-capture', requestId);
    }

    function startProxyStream(cfg, requestId){
      if(!cfg||!cfg.proxyStreamUrl) {
        startDirectStreamIfAvailable(cfg, requestId);
        return;
      }
      if(typeof requestId==='number' && requestId!==streamState.requestId) return;
      stopFallback();
      stopStreamStageTimer();
      streamState.currentTransport='proxy';
      setBadge(streamState.hasEverLoadedStream ? 'Proxy-Stream reconnect...' : 'Verbinde über Proxy...');
      singleImg.src=cfg.proxyStreamUrl+(cfg.proxyStreamUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();
      streamStageTimer=setTimeout(function(){
        if(!panelOpen||singleConfig!==cfg||streamState.currentTransport!=='proxy') return;
        if(typeof requestId==='number' && requestId!==streamState.requestId) return;
        if(streamState.hasEverLoadedStream){
          streamState.consecutiveProxyErrors+=1;
          scheduleProxyReconnect(cfg, requestId);
          return;
        }
        streamState.consecutiveProxyErrors+=1;
        if(streamState.consecutiveProxyErrors<maxInitialProxyErrorsBeforeDirect){
          scheduleProxyReconnect(cfg, requestId);
          return;
        }
        startDirectStreamIfAvailable(cfg, requestId);
      },streamConnectTimeoutMs);
    }

    function startDirectStreamIfAvailable(cfg, requestId){
      if(!cfg||!cfg.streamUrl){
        startProxyCaptureFallback(cfg, requestId);
        return;
      }
      if(typeof requestId==='number' && requestId!==streamState.requestId) return;
      stopFallback();
      stopStreamStageTimer();
      streamState.currentTransport='direct';
      setBadge('Proxy fehlgeschlagen, versuche direkt...');
      singleImg.src=cfg.streamUrl+(cfg.streamUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();
      streamStageTimer=setTimeout(function(){
        if(!panelOpen||singleConfig!==cfg||streamState.currentTransport!=='direct') return;
        if(typeof requestId==='number' && requestId!==streamState.requestId) return;
        startDirectCaptureCheck(cfg, requestId);
      },streamConnectTimeoutMs);
    }

    function startDirectCaptureCheck(cfg, requestId){
      if(!cfg||!cfg.directCaptureUrl){
        startProxyCaptureFallback(cfg, requestId);
        return;
      }
      if(typeof requestId==='number' && requestId!==streamState.requestId) return;
      stopFallback();
      stopStreamStageTimer();
      streamState.currentTransport='direct-capture-check';
      streamState.currentCaptureUrl=cfg.directCaptureUrl;
      setBadge('Teste Direkt-Capture...');
      singleImg.src=cfg.directCaptureUrl+(cfg.directCaptureUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();
      streamStageTimer=setTimeout(function(){
        if(!panelOpen||singleConfig!==cfg||streamState.currentTransport!=='direct-capture-check') return;
        if(typeof requestId==='number' && requestId!==streamState.requestId) return;
        startProxyCaptureFallback(cfg, requestId);
      },streamConnectTimeoutMs);
    }

    function scheduleProxyReconnect(cfg, requestId){
      if(!panelOpen||!cfg||!cfg.proxyStreamUrl){
        startDirectStreamIfAvailable(cfg, requestId);
        return;
      }
      if(streamState.consecutiveProxyErrors>=maxProxyReconnectAttempts){
        startDirectStreamIfAvailable(cfg, requestId);
        return;
      }
      stopProxyReconnectTimer();
      setBadge('Proxy unterbrochen, reconnect...');
      proxyReconnectTimer=setTimeout(function(){
        if(!panelOpen||singleConfig!==cfg) return;
        if(typeof requestId==='number' && requestId!==streamState.requestId) return;
        startProxyStream(cfg, requestId);
      },proxyReconnectDelayMs);
    }

    function scheduleDirectReconnect(cfg, requestId){
      if(!panelOpen||!cfg||!cfg.streamUrl) {
        startProxyCaptureFallback(cfg, requestId);
        return;
      }
      if(streamState.consecutiveDirectErrors>=maxDirectReconnectAttempts){
        startProxyCaptureFallback(cfg, requestId);
        return;
      }
      stopDirectReconnectTimer();
      setBadge('Direktstream unterbrochen, reconnect...');
      directReconnectTimer=setTimeout(function(){
        if(!panelOpen||singleConfig!==cfg) return;
        if(typeof requestId==='number' && requestId!==streamState.requestId) return;
        startDirectStreamIfAvailable(cfg, requestId);
      },directReconnectDelayMs);
    }

    function resetStreamState(preserveLoadedFlag){
      const previousLoadedFlag = !!streamState.hasEverLoadedStream;
      streamState={
        hasEverLoadedStream: preserveLoadedFlag ? previousLoadedFlag : false,
        currentTransport:'',
        currentCaptureUrl:'',
        consecutiveDirectErrors:0,
        consecutiveProxyErrors:0,
        requestId:streamState.requestId
      };
    }

    function loadSingle(options){
      const shouldPreserveLoadedFlag = !!(options && options.preserveLoadedFlag);
      stopAllSingleTimers();
      if(!activeCameraId){singleConfig=null;singleImg.removeAttribute('src');singleEmpty.style.display='';setBadge('');return Promise.resolve();}
      singleEmpty.style.display='none';
      return loadConfig(activeCameraId).then(function(cfg){
        singleConfig=cfg;
        streamState.requestId += 1;
        resetStreamState(shouldPreserveLoadedFlag);
        resetImageTransform();
        startProxyStream(cfg, streamState.requestId);
      }).catch(function(e){setBadge(e&&e.message?e.message:'Kamera offline.');});
    }

    singleImg.addEventListener('load',function(){
      if(!panelOpen||!singleConfig) return;
      const isCapture=singleConfig.captureUrl&&singleImg.src.indexOf(singleConfig.captureUrl)!==-1;
      const isDirectCapture = !!(singleConfig.directCaptureUrl && singleImg.src.indexOf(singleConfig.directCaptureUrl)!==-1);
      const proxyCaptureUrl = singleConfig.proxyCaptureUrl || singleConfig.captureUrl || '';
      const isProxyCapture = !!(proxyCaptureUrl && singleImg.src.indexOf(proxyCaptureUrl)!==-1);
      if(isDirectCapture){
        streamState.currentTransport='direct-capture';
        streamState.currentCaptureUrl=singleConfig.directCaptureUrl;
        setBadge('Direkt-Capture aktiv');
        return;
      }
      if(isProxyCapture || isCapture){
        streamState.currentTransport='proxy-capture';
        streamState.currentCaptureUrl=proxyCaptureUrl;
        setBadge('Fallback: Proxy-Capture');
        return;
      }
      stopStreamStageTimer();
      if(streamState.currentTransport==='proxy'){
        streamState.consecutiveProxyErrors=0;
        setBadge('Proxy aktiv');
      }else{
        streamState.currentTransport='direct';
        streamState.consecutiveDirectErrors=0;
        setBadge('Direktstream aktiv');
      }
      streamState.hasEverLoadedStream=true;
    });
    singleImg.addEventListener('error',function(){
      if(!panelOpen||!singleConfig) return;
      stopStreamStageTimer();
      if(streamState.currentTransport==='proxy-capture'){
        startProxyCaptureFallback(singleConfig, streamState.requestId);
        return;
      }
      if(streamState.currentTransport==='direct-capture' || streamState.currentTransport==='direct-capture-check'){
        startProxyCaptureFallback(singleConfig, streamState.requestId);
        return;
      }
      if(streamState.currentTransport==='proxy'){
        streamState.consecutiveProxyErrors+=1;
        scheduleProxyReconnect(singleConfig, streamState.requestId);
        return;
      }
      streamState.consecutiveDirectErrors+=1;
      if(streamState.hasEverLoadedStream){
        scheduleDirectReconnect(singleConfig, streamState.requestId);
        return;
      }
      scheduleDirectReconnect(singleConfig, streamState.requestId);
    });

    function loadTileCamera(tileImg,cfg,cameraId){
      if(!panelOpen||mode!==modeTile) return;
      if(cfg.proxyStreamUrl){
        tileImg.src=cfg.proxyStreamUrl+(cfg.proxyStreamUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();
        setTimeout(function(){if(panelOpen&&mode===modeTile){tileImg.src=(cfg.proxyCaptureUrl||cfg.captureUrl||'')+((cfg.proxyCaptureUrl||cfg.captureUrl||'').indexOf('?')>=0?'&':'?')+'t='+Date.now();tileTimers[cameraId]=setTimeout(function(){loadTileCamera(tileImg,cfg,cameraId);},Number(cfg.fallbackIntervalMs)>0?Number(cfg.fallbackIntervalMs):1200);}},3000);
      }else if(cfg.proxyCaptureUrl||cfg.captureUrl){
        tileImg.src=(cfg.proxyCaptureUrl||cfg.captureUrl)+(((cfg.proxyCaptureUrl||cfg.captureUrl)||'').indexOf('?')>=0?'&':'?')+'t='+Date.now();
        tileTimers[cameraId]=setTimeout(function(){loadTileCamera(tileImg,cfg,cameraId);},Number(cfg.fallbackIntervalMs)>0?Number(cfg.fallbackIntervalMs):1200);
      }
    }

    function renderTiles(){
      stopTileTimers();
      tilesView.innerHTML='';
      if(!cameras.length){tilesView.innerHTML='<div class="empty">Keine Kameras registriert.</div>';return;}
      cameras.slice(0,6).forEach(function(camera){
        const wrap=document.createElement('div');
        wrap.className='tile';
        wrap.innerHTML='<div class="title"></div><img alt="tile" />';
        wrap.querySelector('.title').textContent=camera.name;
        const tileImg=wrap.querySelector('img');
        tilesView.appendChild(wrap);
        loadConfig(camera.id).then(function(cfg){loadTileCamera(tileImg,cfg,camera.id);}).catch(function(){wrap.querySelector('.title').textContent=camera.name+' (offline)';});
      });
    }

    function renderMode(){
      singleView.classList.toggle('active',mode===modeSingle);
      tilesView.classList.toggle('active',mode===modeTile);
      modeBtn.textContent=mode===modeSingle?'▣':'▣▣';
      if(mode===modeTile){stopFallback();renderTiles();}else{stopTileTimers();if(panelOpen) loadSingle();}
    }

    function refreshRegistry(preferredCameraId){
      return loadRegistry().then(function(data){
        cameras=Array.isArray(data.cameras)?data.cameras:[];
        activeCameraId=preferredCameraId||data.activeCameraId||(cameras[0]?cameras[0].id:'');
        renderSelect();
        return setActiveCamera(activeCameraId).then(function(){if(mode===modeSingle) return loadSingle(); renderTiles();});
      });
    }

    toggle.addEventListener('click',function(){
      const open=!panel.classList.contains('open');
      if(!open){
        panelOpen=false;
        panel.classList.remove('open');
        toggle.classList.remove('active');
        stopAllSingleTimers();
        stopTileTimers();
        streamState.requestId += 1;
        resetStreamState(false);
        singleImg.removeAttribute('src');
        setBadge('');
        return;
      }
      panelOpen=true;panel.classList.add('open');toggle.classList.add('active');refreshRegistry('').catch(function(e){window.alert(e&&e.message?e.message:'Kamera konnte nicht geladen werden.');});
    });

    select.addEventListener('change',function(){
      activeCameraId=select.value||'';
      setActiveCamera(activeCameraId).then(function(){if(mode===modeSingle){loadSingle({ preserveLoadedFlag:false });}else{renderTiles();}}).catch(function(e){window.alert(e&&e.message?e.message:'Kamerawechsel fehlgeschlagen.');});
    });

    addBtn.addEventListener('click',function(){ openAddCameraDialog(); });

    manageBtn.addEventListener('click',function(){ openManageCameraDialog(); });

    modeBtn.addEventListener('click',function(){mode=(mode===modeSingle?modeTile:modeSingle);renderMode();});
    refreshBtn.addEventListener('click',function(){if(!panelOpen) return; if(mode===modeSingle) loadSingle({ preserveLoadedFlag:false }); else renderTiles();});
    settingsBtn.addEventListener('click',function(){if(!singleConfig||!singleConfig.settingsUrl){window.alert('Keine Settings-URL verfügbar.');return;} window.open(singleConfig.settingsUrl,'esp32CameraSettingsWindow','popup=yes,noopener=yes,noreferrer=yes,width=980,height=700');});
    screenshotBtn.addEventListener('click',function(){const bestCaptureUrl=(streamState.currentCaptureUrl|| (singleConfig&&singleConfig.directCaptureUrl) || (singleConfig&&singleConfig.proxyCaptureUrl) || (singleConfig&&singleConfig.captureUrl) || '');if(!bestCaptureUrl){window.alert('Keine Capture-URL vorhanden.');return;} const a=document.createElement('a');const now=new Date();const ts=now.getFullYear()+String(now.getMonth()+1).padStart(2,'0')+String(now.getDate()).padStart(2,'0')+'_'+String(now.getHours()).padStart(2,'0')+String(now.getMinutes()).padStart(2,'0')+String(now.getSeconds()).padStart(2,'0');a.href=bestCaptureUrl+(bestCaptureUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();a.target='_blank';a.rel='noopener';a.download='camera_'+ts+'.jpg';document.body.appendChild(a);a.click();document.body.removeChild(a);});

    attachPanelDrag();
    attachEdgeResize();
    attachImageZoomAndPan();
    resetImageTransform();
    renderMode();
    refreshRegistry('').catch(function(){});
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mountPanel); else mountPanel();
})();`;
return msg;
