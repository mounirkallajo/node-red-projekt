msg.headers = { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" };
msg.payload = `(function(){
  const panelId='cameraFloatingPanel';
  const styleId='cameraFloatingPanelStyle';
  const modeSingle='single';
  const modeTile='tile';
  const storagePrefix='cameraPanel.transport.';
  const probeTimeoutMs=3000;
  const connectTimeoutMs=12000;
  const proxyConnectTimeoutMs=6000;
  const captureRetryDelayMs=4000;
  const snapshotStreamIntervalMs=350;
  const tileMaxCount=6;
  const locationLocal='local';
  const locationExternal='external';
  const cameraDialogWindowParam='cameraDialog';
  const isCameraDialogWindow=(function(){
    try{
      return new URLSearchParams(window.location.search).get(cameraDialogWindowParam)==='1';
    }catch(e){
      return false;
    }
  })();

  const stateIdle='idle';
  const stateProbing='probing';
  const stateConnectingDirect='connectingDirect';
  const stateStreamingDirect='streamingDirect';
  const stateConnectingProxy='connectingProxy';
  const stateStreamingProxy='streamingProxy';
  const stateCaptureFallback='captureFallback';
  const stateOffline='offline';
  const stateOff='off';

  const transportDirect='direct';
  const transportProxy='proxy';

  const badgeText={
    idle:'',
    probing:'Verbindung wird geprüft...',
    connectingDirect:'Verbinde direkt...',
    streamingDirect:'Stream aktiv',
    connectingProxy:'Verbinde über Server-Proxy...',
    streamingProxy:'Stream aktiv (Server-Proxy)',
    captureFallback:'Snapshot-Stream',
    offline:'Kamera nicht erreichbar',
    off:'Aus'
  };
  function locationSuffix(location){
    if(location===locationLocal) return ' (intern)';
    if(location===locationExternal) return ' (extern)';
    return '';
  }
  function composeBadgeText(state,location){
    const base=badgeText[state]||'';
    if(!base) return '';
    if(state===stateStreamingDirect||state===stateStreamingProxy||state===stateCaptureFallback){
      return base+locationSuffix(location);
    }
    return base;
  }

  let panelOpen=false;
  let mode=modeSingle;
  let cameras=[];
  let activeCameraId='';
  const controllers={};
  let imageZoom=1;
  let imagePanX=0;
  let imagePanY=0;

  function addStyle(){
    if(document.getElementById(styleId)) return;
    const style=document.createElement('style');
    style.id=styleId;
    style.textContent='\
#cameraFloatingPanel{position:absolute;top:var(--map-ui-anchor-top,var(--map-ui-panel-top,calc(56px + env(safe-area-inset-top,0px))));right:var(--map-ui-gutter-right,calc(10px + env(safe-area-inset-right,0px)));z-index:1200;width:620px;height:420px;min-width:360px;min-height:260px;background:#fff;border:1px solid #cfd8dc;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.28);display:none;overflow:hidden;}\
#cameraFloatingPanel.open{display:flex;flex-direction:column;}\
@media (max-width:640px){#cameraFloatingPanel.open:not([data-dialog-only="1"]){left:var(--map-ui-gutter-left,calc(10px + env(safe-area-inset-left,0px)))!important;right:var(--map-ui-gutter-right,calc(10px + env(safe-area-inset-right,0px)))!important;width:auto!important;max-width:none!important;}}\
#cameraFloatingPanel .head{display:flex;gap:8px;align-items:center;padding:8px 10px;background:#f4f7fb;border-bottom:1px solid #d9e1e8;cursor:move;}\
#cameraFloatingPanel .head button,#cameraFloatingPanel .head select{border:1px solid #b8c5d1;background:#fff;border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;}\
#cameraFloatingPanel .head .spacer{margin-left:auto;}\
#cameraFloatingPanel .head button[data-hidden="1"]{display:none;}\
#cameraFloatingPanel .head .popout{font-size:16px;line-height:1;padding:2px 8px;}\
#cameraFloatingPanel .body{position:relative;flex:1;min-height:0;background:#000;touch-action:none;}\
#cameraFloatingPanel .resize-handle{position:absolute;z-index:25;background:transparent;}\
#cameraFloatingPanel .resize-handle.handle-e{top:0;right:0;bottom:0;width:12px;cursor:e-resize;}\
#cameraFloatingPanel .resize-handle.handle-w{top:0;left:0;bottom:0;width:12px;cursor:w-resize;}\
#cameraFloatingPanel .resize-handle.handle-n{top:0;left:0;right:0;height:12px;cursor:n-resize;}\
#cameraFloatingPanel .resize-handle.handle-s{bottom:0;left:0;right:0;height:12px;cursor:s-resize;}\
#cameraFloatingPanel .single,#cameraFloatingPanel .tiles{display:none;height:100%;}\
#cameraFloatingPanel .single.active{display:block;position:relative;}\
#cameraFloatingPanel .tiles.active{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;padding:8px;overflow:auto;background:#101010;}\
#cameraFloatingPanel .single img.cameraImage{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;transform-origin:center center;cursor:default;display:none;}\
#cameraFloatingPanel .single img.cameraImage.active{display:block;}\
#cameraFloatingPanel .single .cameraBadge{position:absolute;left:10px;bottom:10px;color:#fff;background:rgba(0,0,0,.6);padding:4px 8px;border-radius:6px;font-size:11px;display:none;z-index:5;}\
#cameraFloatingPanel .single .cameraBadge.active{display:block;}\
#cameraFloatingPanel .single .cameraHint{position:absolute;left:10px;bottom:38px;right:10px;color:#fff;background:rgba(180,80,0,.85);padding:5px 8px;border-radius:6px;font-size:11px;display:none;z-index:5;line-height:1.3;}\
#cameraFloatingPanel .single .cameraHint.active{display:block;}\
#cameraFloatingPanel .empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#c7d0d7;font-size:13px;z-index:1;}\
#cameraFloatingPanel .camera-modal{position:absolute;inset:0;background:rgba(0,0,0,.35);display:none;align-items:center;justify-content:center;z-index:30;}\
#cameraFloatingPanel .camera-modal.open{display:flex;}\
#cameraFloatingPanel .camera-modal-card{width:340px;background:#fff;border-radius:8px;padding:12px;box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:8px;}\
#cameraFloatingPanel .camera-modal-card input{padding:7px 8px;border:1px solid #c4d0da;border-radius:6px;font-size:12px;}\
#cameraFloatingPanel .camera-modal-actions{display:flex;justify-content:flex-end;gap:8px;}\
#cameraFloatingPanel .camera-modal-locationGroup{display:flex;flex-direction:column;gap:4px;background:#f3f6f9;border:1px solid #d9e1e8;border-radius:6px;padding:8px;}\
#cameraFloatingPanel .camera-modal-locationTitle{font-size:11px;font-weight:bold;color:#3a4855;}\
#cameraFloatingPanel .camera-modal-locationOption{font-size:11px;color:#3a4855;display:flex;gap:6px;align-items:flex-start;line-height:1.3;}\
#cameraFloatingPanel .camera-modal-locationOption input{margin-top:2px;}\
#cameraFloatingPanel .camera-manage-list{max-height:220px;overflow:auto;border:1px solid #d9e1e8;border-radius:6px;padding:8px;}\
#cameraFloatingPanel .camera-manage-item{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #eef3f7;}\
#cameraFloatingPanel .camera-manage-item:last-child{border-bottom:0;}\
#cameraFloatingPanel .camera-manage-item .name{font-weight:bold;font-size:12px;}\
#cameraFloatingPanel .camera-manage-item .host{font-size:11px;color:#5d6b78;}\
#cameraFloatingPanel .tile{position:relative;min-height:160px;background:#000;border:1px solid #27313a;border-radius:8px;overflow:hidden;}\
#cameraFloatingPanel .tile img.cameraImage{width:100%;height:100%;object-fit:cover;display:block;}\
#cameraFloatingPanel .tile .cameraBadge{position:absolute;left:6px;bottom:6px;color:#fff;background:rgba(0,0,0,.6);padding:3px 6px;border-radius:4px;font-size:10px;display:none;}\
#cameraFloatingPanel .tile .cameraBadge.active{display:block;}\
#cameraFloatingPanel .tile .cameraHint{display:none;}\
#cameraFloatingPanel .tile .title{position:absolute;left:6px;top:6px;color:#fff;background:rgba(0,0,0,.6);padding:3px 6px;border-radius:4px;font-size:11px;}';
    document.head.appendChild(style);
  }

  function parseJson(r){return r.json();}

  function loadRegistry(){
    return fetch('/api/cameras',{cache:'no-store'}).then(parseJson).then(function(j){
      if(!j||j.ok===false) throw new Error(j&&j.error?j.error:'Kameraliste konnte nicht geladen werden.');
      return j.data||{cameras:[],activeCameraId:''};
    });
  }
  function setActiveCameraOnServer(cameraId){
    return fetch('/api/cameras/active',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cameraId:cameraId||''})}).then(parseJson);
  }
  function addCameraOnServer(name,host,location){
    const body={name:name,host:host};
    if(location) body.location=location;
    return fetch('/api/cameras',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(parseJson).then(function(j){
      if(!j||j.ok===false) throw new Error(j&&j.error?j.error:'Kamera konnte nicht hinzugefügt werden.');
      return j;
    });
  }
  function removeCameraOnServer(id){
    return fetch('/api/cameras/'+encodeURIComponent(id),{method:'DELETE'}).then(parseJson).then(function(j){
      if(!j||j.ok===false) throw new Error(j&&j.error?j.error:'Kamera konnte nicht gelöscht werden.');
      return j;
    });
  }
  function loadCameraConfig(cameraId){
    const suffix=cameraId?('?cameraId='+encodeURIComponent(cameraId)):'';
    return fetch('/api/camera/config'+suffix,{cache:'no-store'}).then(parseJson).then(function(j){
      if(!j||j.ok===false||!j.data) throw new Error(j&&j.error?j.error:'Kamera-Konfiguration fehlt.');
      return j.data;
    });
  }
  function readSessionTransport(cameraId){
    try{
      if(window.sessionStorage){
        const v=window.sessionStorage.getItem(storagePrefix+cameraId);
        if(v===transportDirect||v===transportProxy) return v;
      }
    }catch(e){}
    return '';
  }
  function writeSessionTransport(cameraId,value){
    try{
      if(!window.sessionStorage) return;
      if(value===transportDirect||value===transportProxy) window.sessionStorage.setItem(storagePrefix+cameraId,value);
      else window.sessionStorage.removeItem(storagePrefix+cameraId);
    }catch(e){}
  }

  function appendCacheBuster(url){
    if(!url) return '';
    return url+(url.indexOf('?')>=0?'&':'?')+'t='+Date.now();
  }

  function CameraController(cameraId){
    this.cameraId=cameraId;
    this.config=null;
    this.configLoading=null;
    this.state=stateIdle;
    this.requestSeq=0;
    this.preferredTransport=readSessionTransport(cameraId);
    this.lastTriedTransport='';
    this.lastSuccessfulTransport='';
    this.directRouteFailed=false;
    this.timers={connect:null,captureRetry:null};
    this.probeAbort=null;
    this.imgEl=document.createElement('img');
    this.imgEl.alt='Camera';
    this.imgEl.className='cameraImage';
    this.imgEl.dataset.cameraId=cameraId;
    this.badgeEl=document.createElement('div');
    this.badgeEl.className='cameraBadge';
    this.badgeEl.dataset.cameraId=cameraId;
    this.hintEl=document.createElement('div');
    this.hintEl.className='cameraHint';
    this.hintEl.dataset.cameraId=cameraId;
    const self=this;
    this._onLoad=function(){self._handleImgLoad();};
    this._onError=function(){self._handleImgError();};
    this.imgEl.addEventListener('load',this._onLoad);
    this.imgEl.addEventListener('error',this._onError);
  }

  CameraController.prototype._setBadge=function(text){
    if(text){this.badgeEl.textContent=text;this.badgeEl.classList.add('active');}
    else{this.badgeEl.textContent='';this.badgeEl.classList.remove('active');}
  };
  CameraController.prototype._setHint=function(text){
    if(text){this.hintEl.textContent=text;this.hintEl.classList.add('active');}
    else{this.hintEl.textContent='';this.hintEl.classList.remove('active');}
  };
  CameraController.prototype._transition=function(next){
    this.state=next;
    const cameraLocation=this.config&&this.config.location;
    this._setBadge(composeBadgeText(next,cameraLocation));
    this._refreshHint();
  };
  CameraController.prototype._refreshHint=function(){
    if(this.directRouteFailed&&(this.state===stateStreamingProxy||this.state===stateCaptureFallback||this.state===stateConnectingProxy)){
      this._setHint('Tipp: Tailscale-Subnet auf diesem Gerät akzeptieren ("Use Tailscale subnets"), damit der Direktstream zur Kamera funktioniert.');
    } else {
      this._setHint('');
    }
  };
  CameraController.prototype._clearTimers=function(){
    if(this.timers.connect){clearTimeout(this.timers.connect);this.timers.connect=null;}
    if(this.timers.captureRetry){clearTimeout(this.timers.captureRetry);this.timers.captureRetry=null;}
    if(this.probeAbort){
      try{this.probeAbort.abort();}catch(e){}
      this.probeAbort=null;
    }
  };
  CameraController.prototype._stopImage=function(){
    try{this.imgEl.removeAttribute('src');}catch(e){}
  };
  CameraController.prototype.setVisible=function(visible){
    if(visible){
      this.imgEl.classList.add('active');
      if(this.badgeEl.textContent) this.badgeEl.classList.add('active');
      if(this.hintEl.textContent) this.hintEl.classList.add('active');
    } else {
      this.imgEl.classList.remove('active');
      this.badgeEl.classList.remove('active');
      this.hintEl.classList.remove('active');
    }
  };
  CameraController.prototype.mountTo=function(parent){
    if(!parent) return;
    if(this.imgEl.parentNode!==parent) parent.appendChild(this.imgEl);
    if(this.badgeEl.parentNode!==parent) parent.appendChild(this.badgeEl);
    if(this.hintEl.parentNode!==parent) parent.appendChild(this.hintEl);
  };
  CameraController.prototype.unmount=function(){
    if(this.imgEl.parentNode) this.imgEl.parentNode.removeChild(this.imgEl);
    if(this.badgeEl.parentNode) this.badgeEl.parentNode.removeChild(this.badgeEl);
    if(this.hintEl.parentNode) this.hintEl.parentNode.removeChild(this.hintEl);
  };
  CameraController.prototype.suspend=function(){
    this.requestSeq+=1;
    this._clearTimers();
    this._stopImage();
    if(this.state!==stateOff) this._transition(stateIdle);
  };
  CameraController.prototype.dispose=function(){
    this.suspend();
    this.unmount();
    this.imgEl.removeEventListener('load',this._onLoad);
    this.imgEl.removeEventListener('error',this._onError);
  };
  CameraController.prototype.reload=function(){
    if(this.state===stateOff) return;
    this.suspend();
    this.activate();
  };
  CameraController.prototype.turnOff=function(){
    this.suspend();
    this._transition(stateOff);
  };
  CameraController.prototype.turnOn=function(){
    if(this.state!==stateOff) return;
    this._transition(stateIdle);
    this.activate();
  };
  CameraController.prototype.isOff=function(){return this.state===stateOff;};
  CameraController.prototype.isStreaming=function(){
    return this.state===stateStreamingDirect||this.state===stateStreamingProxy||this.state===stateCaptureFallback;
  };

  CameraController.prototype.activate=function(){
    if(!panelOpen) return;
    if(this.state===stateOff) return;
    if(this.state!==stateIdle&&this.state!==stateOffline) return;
    const self=this;
    this._ensureConfig().then(function(cfg){
      if(!cfg) return;
      if(self.state===stateOff||!panelOpen) return;
      self._beginConnect();
    }).catch(function(){
      self._transition(stateOffline);
    });
  };

  CameraController.prototype._ensureConfig=function(){
    const self=this;
    if(this.config) return Promise.resolve(this.config);
    if(this.configLoading) return this.configLoading;
    this.configLoading=loadCameraConfig(this.cameraId).then(function(cfg){
      self.config=cfg;
      self.configLoading=null;
      return cfg;
    },function(e){
      self.configLoading=null;
      throw e;
    });
    return this.configLoading;
  };

  CameraController.prototype._beginConnect=function(){
    this.requestSeq+=1;
    const seq=this.requestSeq;
    this.lastTriedTransport='';
    const cameraLocation=this.config&&this.config.location;
    const hasDirectStream=this.config&&this.config.streamUrl;
    const hasProxyStream=this.config&&this.config.proxyStreamUrl;
    if((cameraLocation===locationLocal||cameraLocation===locationExternal)&&hasDirectStream){
      this._connectDirect(seq);
      return;
    }
    if(this.preferredTransport===transportDirect&&hasDirectStream){
      this._connectDirect(seq);
      return;
    }
    if(this.preferredTransport===transportProxy&&hasProxyStream){
      this._connectProxy(seq);
      return;
    }
    this._probe(seq);
  };

  CameraController.prototype._probe=function(seq){
    if(seq!==this.requestSeq) return;
    this._transition(stateProbing);
    if(!this.config||!this.config.directCaptureUrl){
      this._connectProxy(seq);
      return;
    }
    const self=this;
    let aborter=null;
    try{aborter=new AbortController();}catch(e){aborter=null;}
    this.probeAbort=aborter;
    const probeUrl=appendCacheBuster(this.config.directCaptureUrl);
    const timeoutId=setTimeout(function(){
      if(aborter){try{aborter.abort();}catch(e){}}
    },probeTimeoutMs);
    fetch(probeUrl,{
      method:'GET',
      cache:'no-store',
      mode:'no-cors',
      signal:aborter?aborter.signal:undefined
    }).then(function(){
      clearTimeout(timeoutId);
      if(seq!==self.requestSeq) return;
      self.probeAbort=null;
      self._connectDirect(seq);
    }).catch(function(){
      clearTimeout(timeoutId);
      if(seq!==self.requestSeq) return;
      self.probeAbort=null;
      self._connectProxy(seq);
    });
  };

  CameraController.prototype._connectDirect=function(seq){
    if(seq!==this.requestSeq) return;
    if(!this.config||!this.config.streamUrl){
      this._connectProxy(seq);
      return;
    }
    if(this.timers.connect){clearTimeout(this.timers.connect);this.timers.connect=null;}
    this.lastTriedTransport=transportDirect;
    this._transition(stateConnectingDirect);
    this.imgEl.src=appendCacheBuster(this.config.streamUrl);
    const self=this;
    this.timers.connect=setTimeout(function(){
      if(seq!==self.requestSeq) return;
      if(self.state!==stateConnectingDirect) return;
      self._handleStreamFailure(seq);
    },connectTimeoutMs);
  };

  CameraController.prototype._connectProxy=function(seq){
    if(seq!==this.requestSeq) return;
    if(!this.config||!this.config.proxyStreamUrl){
      this._startCaptureFallback(seq);
      return;
    }
    if(this.timers.connect){clearTimeout(this.timers.connect);this.timers.connect=null;}
    this.lastTriedTransport=transportProxy;
    this._transition(stateConnectingProxy);
    this.imgEl.src=appendCacheBuster(this.config.proxyStreamUrl);
    const self=this;
    this.timers.connect=setTimeout(function(){
      if(seq!==self.requestSeq) return;
      if(self.state!==stateConnectingProxy) return;
      self._handleStreamFailure(seq);
    },proxyConnectTimeoutMs);
  };

  CameraController.prototype._handleStreamFailure=function(seq){
    if(seq!==this.requestSeq) return;
    if(this.timers.connect){clearTimeout(this.timers.connect);this.timers.connect=null;}
    if(this.lastTriedTransport===transportDirect){
      const cameraLocation=this.config&&this.config.location;
      if(cameraLocation===locationLocal||cameraLocation===locationExternal){
        this.directRouteFailed=true;
      }
      writeSessionTransport(this.cameraId,'');
      this.preferredTransport='';
      this._connectProxy(seq);
      return;
    }
    if(this.lastTriedTransport===transportProxy){
      writeSessionTransport(this.cameraId,'');
      this.preferredTransport='';
      this._startCaptureFallback(seq);
      return;
    }
    this._startCaptureFallback(seq);
  };

  CameraController.prototype._startCaptureFallback=function(seq){
    if(seq!==this.requestSeq) return;
    if(!this.config){this._transition(stateOffline);return;}
    const captureUrl=this.config.proxyCaptureUrl||this.config.captureUrl||'';
    if(!captureUrl){this._transition(stateOffline);return;}
    this._transition(stateCaptureFallback);
    this._captureTick(seq,captureUrl);
  };

  CameraController.prototype._captureTick=function(seq,url){
    if(seq!==this.requestSeq||this.state!==stateCaptureFallback) return;
    this.imgEl.src=appendCacheBuster(url);
    const self=this;
    const interval=Number(this.config&&this.config.fallbackIntervalMs)>0?Number(this.config.fallbackIntervalMs):snapshotStreamIntervalMs;
    this.timers.captureRetry=setTimeout(function(){
      self._captureTick(seq,url);
    },interval);
  };

  CameraController.prototype._handleImgLoad=function(){
    if(this.state===stateConnectingDirect){
      if(this.timers.connect){clearTimeout(this.timers.connect);this.timers.connect=null;}
      this.directRouteFailed=false;
      this._transition(stateStreamingDirect);
      writeSessionTransport(this.cameraId,transportDirect);
      this.preferredTransport=transportDirect;
      this.lastSuccessfulTransport=transportDirect;
      return;
    }
    if(this.state===stateConnectingProxy){
      if(this.timers.connect){clearTimeout(this.timers.connect);this.timers.connect=null;}
      this._transition(stateStreamingProxy);
      writeSessionTransport(this.cameraId,transportProxy);
      this.preferredTransport=transportProxy;
      this.lastSuccessfulTransport=transportProxy;
      return;
    }
  };

  CameraController.prototype._handleImgError=function(){
    if(!panelOpen) return;
    if(this.state===stateConnectingDirect||this.state===stateStreamingDirect||
       this.state===stateConnectingProxy||this.state===stateStreamingProxy){
      this._handleStreamFailure(this.requestSeq);
      return;
    }
    if(this.state===stateCaptureFallback){
      const seq=this.requestSeq;
      if(this.timers.captureRetry){clearTimeout(this.timers.captureRetry);this.timers.captureRetry=null;}
      const url=(this.config&&(this.config.proxyCaptureUrl||this.config.captureUrl))||'';
      const self=this;
      if(!url){this._transition(stateOffline);return;}
      this.timers.captureRetry=setTimeout(function(){
        if(seq!==self.requestSeq||self.state!==stateCaptureFallback) return;
        self._captureTick(seq,url);
      },captureRetryDelayMs);
    }
  };

  CameraController.prototype.getBestCaptureUrl=function(){
    if(!this.config) return '';
    if(this.lastSuccessfulTransport===transportDirect&&this.config.directCaptureUrl) return this.config.directCaptureUrl;
    return this.config.proxyCaptureUrl||this.config.captureUrl||this.config.directCaptureUrl||'';
  };

  function getOrCreateController(cameraId){
    if(!controllers[cameraId]) controllers[cameraId]=new CameraController(cameraId);
    return controllers[cameraId];
  }
  function disposeRemovedControllers(){
    Object.keys(controllers).forEach(function(id){
      if(!cameras.find(function(c){return c.id===id;})){
        controllers[id].dispose();
        delete controllers[id];
      }
    });
  }
  function suspendAllControllers(){
    Object.keys(controllers).forEach(function(id){
      const c=controllers[id];
      if(c.state!==stateOff) c.suspend();
    });
  }
  function getActiveController(){
    return activeCameraId?(controllers[activeCameraId]||null):null;
  }

  function mountPanel(){
    const toggle=document.getElementById('cameraToggleBtn');
    const host=document.getElementById('cameraPanelHost');
    if(!toggle||!host) return;
    addStyle();
    const panel=document.createElement('div');
    panel.id=panelId;
    panel.innerHTML='<div class="head">'+
      '<select id="cameraSelect"></select>'+
      '<button id="cameraAddBtn" type="button">+</button>'+
      '<button id="cameraManageBtn" type="button">Liste</button>'+
      '<button id="cameraModeBtn" type="button" title="Einzel/Kachel">▣</button>'+
      '<span class="spacer"></span>'+
      '<button id="cameraPowerBtn" type="button">Aus</button>'+
      '<button id="cameraSettingsBtn" type="button">Settings</button>'+
      '<button id="cameraRefreshBtn" type="button">Neu laden</button>'+
      '<button id="cameraScreenshotBtn" type="button">Screenshot</button>'+
      '<button id="cameraPopoutBtn" class="popout" type="button" title="In neuem Fenster öffnen">↗</button>'+
      '</div>'+
      '<div class="resize-handle handle-e" data-resize-dir="e"></div>'+
      '<div class="resize-handle handle-w" data-resize-dir="w"></div>'+
      '<div class="resize-handle handle-n" data-resize-dir="n"></div>'+
      '<div class="resize-handle handle-s" data-resize-dir="s"></div>'+
      '<div class="body">'+
      '<div id="singleStage" class="single active"><div id="singleEmpty" class="empty" style="display:none">Keine Kamera ausgewählt.</div></div>'+
      '<div id="tilesView" class="tiles"></div>'+
      '<div id="cameraModal" class="camera-modal"></div>'+
      '</div>';
    host.appendChild(panel);

    const select=panel.querySelector('#cameraSelect');
    const addBtn=panel.querySelector('#cameraAddBtn');
    const manageBtn=panel.querySelector('#cameraManageBtn');
    const modeBtn=panel.querySelector('#cameraModeBtn');
    const popoutBtn=panel.querySelector('#cameraPopoutBtn');
    const powerBtn=panel.querySelector('#cameraPowerBtn');
    const settingsBtn=panel.querySelector('#cameraSettingsBtn');
    const refreshBtn=panel.querySelector('#cameraRefreshBtn');
    const screenshotBtn=panel.querySelector('#cameraScreenshotBtn');
    const singleStage=panel.querySelector('#singleStage');
    const tilesView=panel.querySelector('#tilesView');
    const singleEmpty=panel.querySelector('#singleEmpty');
    const modalElement=panel.querySelector('#cameraModal');

    function openPanel(){
      panelOpen=true;
      panel.classList.add('open');
      toggle.classList.add('active');
      if(typeof window.__updateMapUiLayout==='function'){
        window.__updateMapUiLayout();
      }else if(panel.dataset.userMoved!=='1'){
        panel.style.top='';
        panel.style.right='';
      }
      refreshRegistry('').catch(function(e){
        window.alert(e&&e.message?e.message:'Kamera konnte nicht geladen werden.');
      });
    }
    function closePanel(){
      panelOpen=false;
      panel.classList.remove('open');
      toggle.classList.remove('active');
      suspendAllControllers();
    }
    function turnOffAllControllers(){
      Object.keys(controllers).forEach(function(id){
        const controller=controllers[id];
        if(!controller||controller.state===stateOff) return;
        controller.turnOff();
      });
    }
    function openPopoutWindow(){
      let popoutUrl='';
      try{
        const url=new URL(window.location.href);
        url.searchParams.set(cameraDialogWindowParam,'1');
        popoutUrl=url.toString();
      }catch(e){
        const hasQuery=window.location.href.indexOf('?')>=0;
        popoutUrl=window.location.href+(hasQuery?'&':'?')+cameraDialogWindowParam+'=1';
      }
      window.open(popoutUrl,'cameraDialogWindow','popup=yes,noopener=yes,noreferrer=yes,width=1260,height=860');
    }
    function setupDialogOnlyWindow(){
      if(!isCameraDialogWindow) return;
      const mapEl=document.getElementById('map');
      if(mapEl) mapEl.style.display='none';
      document.body.style.background='#0f1419';
      panel.style.position='fixed';
      panel.style.top='12px';
      panel.style.left='12px';
      panel.style.right='12px';
      panel.style.bottom='12px';
      panel.style.width='auto';
      panel.style.height='auto';
      panel.style.maxWidth='none';
      panel.style.maxHeight='none';
      panel.style.zIndex='9999';
      if(popoutBtn) popoutBtn.setAttribute('data-hidden','1');
      openPanel();
    }

    function renderSelect(){
      const parts=['<option value="">Kamera wählen</option>'];
      cameras.forEach(function(camera){
        parts.push('<option value="'+camera.id+'"'+(camera.id===activeCameraId?' selected':'')+'>'+camera.name+'</option>');
      });
      select.innerHTML=parts.join('');
    }

    function updatePowerButton(){
      const active=getActiveController();
      if(mode!==modeSingle||!active){
        powerBtn.setAttribute('data-hidden','1');
        return;
      }
      powerBtn.removeAttribute('data-hidden');
      powerBtn.textContent=active.isOff()?'Ein':'Aus';
    }

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
        '<div class="camera-modal-locationGroup">',
        '  <div class="camera-modal-locationTitle">Standort der Kamera</div>',
        '  <label class="camera-modal-locationOption"><input type="radio" name="cameraInputLocation" value="local" checked /> Im Server-Netz (Raspberry kündigt 192.168.1.0/24 via Tailscale an)</label>',
        '  <label class="camera-modal-locationOption"><input type="radio" name="cameraInputLocation" value="external" /> Extern via Tailscale-Route (anderes Gerät kündigt Subnetz der Kamera an)</label>',
        '</div>',
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
      function readSelectedLocation(){
        const checked=modalElement.querySelector('input[name="cameraInputLocation"]:checked');
        const value=checked?String(checked.value||'').trim():'';
        return value==='external'?'external':'local';
      }
      function saveCamera(){
        const cameraName=String((nameInput&&nameInput.value)||'').trim();
        const cameraHost=String((hostInput&&hostInput.value)||'').trim();
        const cameraLocation=readSelectedLocation();
        if(!cameraName||!cameraHost){
          window.alert('Name und IP/Host sind erforderlich.');
          return;
        }
        addCameraOnServer(cameraName,cameraHost,cameraLocation).then(function(res){
          closeModal();
          return refreshRegistry(res&&res.data?res.data.activeCameraId:'');
        }).catch(function(error){
          window.alert(error&&error.message?error.message:'Kamera konnte nicht gespeichert werden.');
        });
      }
      if(cancelButton) cancelButton.addEventListener('click',closeModal);
      if(saveButton) saveButton.addEventListener('click',saveCamera);
      [nameInput,hostInput].forEach(function(inp){
        if(!inp) return;
        inp.addEventListener('keydown',function(event){
          if(event.key==='Enter'){
            const next=inp===nameInput?hostInput:null;
            if(next) next.focus(); else saveCamera();
          }
        });
      });
    }
    function openManageCameraDialog(){
      const listHtml=cameras.map(function(camera){
        const cameraLocation=camera.location==='external'?'extern (Tailscale-Route)':'lokal (Server-Netz)';
        return [
          '<div class="camera-manage-item" data-camera-id="'+camera.id+'">',
          '  <div style="flex:1;">',
          '    <div class="name">'+camera.name+'</div>',
          '    <div class="host">'+camera.host+' &middot; '+cameraLocation+'</div>',
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
          removeCameraOnServer(cameraId).then(function(){
            closeModal();
            return refreshRegistry('');
          }).catch(function(error){
            window.alert(error&&error.message?error.message:'Kamera konnte nicht entfernt werden.');
          });
        });
      });
    }

    function applyImageTransform(){
      const active=getActiveController();
      if(!active) return;
      active.imgEl.style.transform='translate('+imagePanX+'px,'+imagePanY+'px) scale('+imageZoom+')';
      active.imgEl.style.cursor=imageZoom>1?'grab':'default';
    }
    function clampImagePan(){
      const viewRect=singleStage.getBoundingClientRect();
      const maxPanX=Math.max(0,(viewRect.width*(imageZoom-1))/2);
      const maxPanY=Math.max(0,(viewRect.height*(imageZoom-1))/2);
      imagePanX=Math.max(-maxPanX,Math.min(maxPanX,imagePanX));
      imagePanY=Math.max(-maxPanY,Math.min(maxPanY,imagePanY));
    }
    function resetImageTransform(){
      imageZoom=1;
      imagePanX=0;
      imagePanY=0;
      const active=getActiveController();
      if(active){
        active.imgEl.style.transform='';
        active.imgEl.style.cursor='default';
      }
    }
    function attachImageZoomAndPan(){
      singleStage.addEventListener('wheel',function(event){
        if(mode!==modeSingle||!panelOpen) return;
        event.preventDefault();
        const zoomDelta=event.deltaY<0?0.15:-0.15;
        imageZoom=Math.max(1,Math.min(10,imageZoom+zoomDelta));
        if(imageZoom===1){imagePanX=0;imagePanY=0;}
        else clampImagePan();
        applyImageTransform();
      },{passive:false});
      singleStage.addEventListener('pointerdown',function(event){
        if(mode!==modeSingle||imageZoom<=1) return;
        const target=event.target;
        if(target&&target.classList&&target.classList.contains('cameraImage')){}else return;
        event.preventDefault();
        const startX=event.clientX;
        const startY=event.clientY;
        const startPanX=imagePanX;
        const startPanY=imagePanY;
        target.style.cursor='grabbing';
        function onMove(moveEvent){
          imagePanX=startPanX+(moveEvent.clientX-startX);
          imagePanY=startPanY+(moveEvent.clientY-startY);
          clampImagePan();
          applyImageTransform();
        }
        function onUp(){
          target.style.cursor=imageZoom>1?'grab':'default';
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
        panel.dataset.userMoved='1';
        function onMove(moveEvent){
          const deltaX=moveEvent.clientX-startX;
          const deltaY=moveEvent.clientY-startY;
          panel.style.left=Math.round(startLeft+deltaX)+'px';
          panel.style.top=Math.round(startTop+deltaY)+'px';
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
          panel.dataset.userMoved='1';
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

    function detachAllControllersFromUi(){
      Object.keys(controllers).forEach(function(id){
        const c=controllers[id];
        c.unmount();
        c.setVisible(false);
      });
    }

    function renderSingleMode(){
      tilesView.classList.remove('active');
      tilesView.innerHTML='';
      singleStage.classList.add('active');
      detachAllControllersFromUi();
      cameras.forEach(function(camera){
        const c=getOrCreateController(camera.id);
        c.mountTo(singleStage);
      });
      const active=getActiveController();
      if(!active){
        singleEmpty.style.display='';
        return;
      }
      singleEmpty.style.display='none';
      Object.keys(controllers).forEach(function(id){
        const c=controllers[id];
        const isActive=id===activeCameraId;
        c.setVisible(isActive);
        if(!isActive&&c.state!==stateOff) c.suspend();
      });
      resetImageTransform();
      if(panelOpen) active.activate();
    }

    function renderTileMode(){
      singleStage.classList.remove('active');
      tilesView.classList.add('active');
      tilesView.innerHTML='';
      detachAllControllersFromUi();
      if(!cameras.length){
        tilesView.innerHTML='<div class="empty">Keine Kameras registriert.</div>';
        return;
      }
      cameras.slice(0,tileMaxCount).forEach(function(camera){
        const wrapper=document.createElement('div');
        wrapper.className='tile';
        const titleEl=document.createElement('div');
        titleEl.className='title';
        titleEl.textContent=camera.name;
        wrapper.appendChild(titleEl);
        tilesView.appendChild(wrapper);
        const c=getOrCreateController(camera.id);
        c.mountTo(wrapper);
        c.setVisible(true);
        if(panelOpen) c.activate();
      });
    }

    function renderMode(){
      modeBtn.textContent=mode===modeSingle?'▣':'▣▣';
      if(mode===modeSingle) renderSingleMode();
      else renderTileMode();
      updatePowerButton();
    }

    function refreshRegistry(preferredCameraId){
      return loadRegistry().then(function(data){
        cameras=Array.isArray(data.cameras)?data.cameras:[];
        activeCameraId=preferredCameraId||data.activeCameraId||(cameras[0]?cameras[0].id:'');
        renderSelect();
        disposeRemovedControllers();
        return setActiveCameraOnServer(activeCameraId).then(function(){
          renderMode();
        });
      });
    }

    toggle.addEventListener('click',function(){
      const open=!panel.classList.contains('open');
      if(!open){
        closePanel();
        return;
      }
      openPanel();
    });

    select.addEventListener('change',function(){
      const previousActiveId=activeCameraId;
      activeCameraId=select.value||'';
      if(previousActiveId&&controllers[previousActiveId]&&controllers[previousActiveId].state!==stateOff){
        controllers[previousActiveId].suspend();
      }
      setActiveCameraOnServer(activeCameraId).then(function(){
        renderMode();
      }).catch(function(e){
        window.alert(e&&e.message?e.message:'Kamerawechsel fehlgeschlagen.');
      });
    });

    addBtn.addEventListener('click',function(){openAddCameraDialog();});
    manageBtn.addEventListener('click',function(){openManageCameraDialog();});

    modeBtn.addEventListener('click',function(){
      if(mode===modeSingle){
        mode=modeTile;
      }else{
        mode=modeSingle;
        Object.keys(controllers).forEach(function(id){
          if(id!==activeCameraId&&controllers[id].state!==stateOff) controllers[id].suspend();
        });
      }
      renderMode();
    });
    popoutBtn.addEventListener('click',function(){
      turnOffAllControllers();
      closePanel();
      openPopoutWindow();
    });

    refreshBtn.addEventListener('click',function(){
      if(!panelOpen) return;
      if(mode===modeSingle){
        const active=getActiveController();
        if(active) active.reload();
      }else{
        cameras.slice(0,tileMaxCount).forEach(function(camera){
          const c=controllers[camera.id];
          if(c) c.reload();
        });
      }
      updatePowerButton();
    });

    powerBtn.addEventListener('click',function(){
      const active=getActiveController();
      if(!active) return;
      if(active.isOff()) active.turnOn();
      else active.turnOff();
      updatePowerButton();
    });

    settingsBtn.addEventListener('click',function(){
      const active=getActiveController();
      const cfg=active?active.config:null;
      if(!cfg||!cfg.settingsUrl){
        window.alert('Keine Settings-URL verfügbar.');
        return;
      }
      window.open(cfg.settingsUrl,'esp32CameraSettingsWindow','popup=yes,noopener=yes,noreferrer=yes,width=980,height=700');
    });

    screenshotBtn.addEventListener('click',function(){
      const active=getActiveController();
      const captureUrl=active?active.getBestCaptureUrl():'';
      if(!captureUrl){
        window.alert('Keine Capture-URL vorhanden.');
        return;
      }
      const a=document.createElement('a');
      const now=new Date();
      const ts=now.getFullYear()+String(now.getMonth()+1).padStart(2,'0')+String(now.getDate()).padStart(2,'0')+'_'+String(now.getHours()).padStart(2,'0')+String(now.getMinutes()).padStart(2,'0')+String(now.getSeconds()).padStart(2,'0');
      const namePrefix=(active&&active.config&&active.config.screenshotNamePrefix)||'camera';
      a.href=captureUrl+(captureUrl.indexOf('?')>=0?'&':'?')+'t='+Date.now();
      a.target='_blank';
      a.rel='noopener';
      a.download=namePrefix+'_'+ts+'.jpg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    attachPanelDrag();
    attachEdgeResize();
    attachImageZoomAndPan();
    updatePowerButton();
    setupDialogOnlyWindow();
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',mountPanel); else mountPanel();
})();`;
return msg;
