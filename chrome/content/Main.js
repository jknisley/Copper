/*******************************************************************************
 * Copyright (c) 2012, Institute for Pervasive Computing, ETH Zurich.
 * All rights reserved.
 * 
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the Institute nor the names of its contributors
 *    may be used to endorse or promote products derived from this software
 *    without specific prior written permission.
 * 
 * THIS SOFTWARE IS PROVIDED BY THE INSTITUTE AND CONTRIBUTORS "AS IS" AND
 * ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED.  IN NO EVENT SHALL THE INSTITUTE OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 * OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 * LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 * OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 * SUCH DAMAGE.
 * 
 * This file is part of the Copper CoAP browser.
 ******************************************************************************/
/**
 * \file
 *         Main program code for the Copper CoAP Browser
 *
 * \author  Matthias Kovatsch <kovatsch@inf.ethz.ch>\author
 */

// namespace
Components.utils.import("resource://drafts/common.jsm");

// file IO
Components.utils.import("resource://gre/modules/NetUtil.jsm");

CopperChrome.mainWindow = window.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
		.getInterface(Components.interfaces.nsIWebNavigation)
		.QueryInterface(Components.interfaces.nsIDocShellTreeItem)
		.rootTreeItem
		.QueryInterface(Components.interfaces.nsIInterfaceRequestor)
		.getInterface(Components.interfaces.nsIDOMWindow);

CopperChrome.prefManager = Components.classes['@mozilla.org/preferences-service;1'].getService(Components.interfaces.nsIPrefBranch);

CopperChrome.coapVersion = 7;

CopperChrome.hostname = '';
CopperChrome.port = -1;
CopperChrome.path = '/';
CopperChrome.query = '';

CopperChrome.client = null;
CopperChrome.observer = null;

CopperChrome.resources = new Object();
CopperChrome.resourcesCached = true;

CopperChrome.payloadFile = '';
CopperChrome.payloadFileLoaded = false;
CopperChrome.payloadFileData = null;

CopperChrome.uploadMethod = 0;
CopperChrome.uploadBlocks = null;

CopperChrome.behavior = {
	retransmission: true,
	showUnknown: false,
	rejectUnknown: true,
	blockSize: 64,
	observeToken: true,
	observeCancellation: 'lazy'
};

// Life cycle functions
////////////////////////////////////////////////////////////////////////////////

CopperChrome.main = function() {
	
	dump(Array(5).join('\n'));
	dump('==============================================================================\n');
	dump('=INITIALIZING COPPER==========================================================\n');
	dump('==============================================================================\n');
		
 	// set the Cu icon for all Copper tabs
	// TODO: There must be a more elegant way
	var tabbrowser = Components.classes["@mozilla.org/appshell/window-mediator;1"].getService(Components.interfaces.nsIWindowMediator).getEnumerator("navigator:browser").getNext().gBrowser;  
	for (var i=0; i<tabbrowser.browsers.length; ++i) {
		if (tabbrowser.mTabs[i].label=='Copper CoAP Browser')
		tabbrowser.setIcon(tabbrowser.mTabs[i], 'chrome://copper/skin/Cu_16.png');
	}
	
	// get settings from preferences
	var auto = null; // auto-method
	try {
		CopperChrome.coapVersion = CopperChrome.prefManager.getIntPref('extensions.copper.coap-version');
		
		document.getElementById('resource_split').setAttribute('state', CopperChrome.prefManager.getBoolPref('extensions.copper.use-tree') ? 'open' : 'collapsed');
		document.getElementById('resource_split').hidden = !CopperChrome.prefManager.getBoolPref('extensions.copper.use-tree');
		
		auto = CopperChrome.prefManager.getIntPref('extensions.copper.auto-request.method');
		
		CopperChrome.loadBehavior();
		CopperChrome.loadDebugOptions();
		
	} catch (ex) {
		window.setTimeout(
				function() { window.alert('WARNING: Could not load preferences; using hardcoded defauls.'+ex); },
				0);
	}
	
	try {
		// keep dangerous object loader local
		let loader = Components.classes["@mozilla.org/moz/jssubscript-loader;1"].getService(Components.interfaces.mozIJSSubScriptLoader);
		
		switch (CopperChrome.coapVersion) {
			case 3:
				loader.loadSubScript("resource://drafts/CoapPacket03.jsm");
				break;
			case 6:
				loader.loadSubScript("resource://drafts/CoapPacket06.jsm");
				break;
			case 7:
			case 8:
				loader.loadSubScript("resource://drafts/CoapPacket07.jsm");
				break;
			default:
				window.setTimeout(
						function() { window.alert('WARNING: CoAP version '+CopperChrome.coapVersion+' not implemented. Using 07/08.'); },
						0);
				loader.loadSubScript("resource://drafts/CoapPacket07.jsm");
				CopperChrome.coapVersion = 8;
				break;
		}
		
		document.getElementById('toolbar_version').label = 'CoAP ' + Copper.leadingZero(CopperChrome.coapVersion,2) + ' ';
		CopperChrome.initDebugContentTypes();
		
	} catch (ex) {
		window.setTimeout(
				function() { window.alert('ERROR: Could not load protocol module ['+ex+']'); },
				0);
	}
	
	// open location
	try {
		// Header table workaround to hide useless scrollbar
		document.getElementById('packet_header').focus();
		document.getElementById('packet_options').focus();
		
		CopperChrome.parseUri(document.location.href);
		
		// set up datagram and transaction layer
		var temp = new CopperChrome.UdpClient(CopperChrome.hostname, CopperChrome.port);
		temp.registerErrorCallback(CopperChrome.errorHandler);
		CopperChrome.client = new CopperChrome.TransactionHandler(temp, CopperChrome.behavior.retransmissions);
		CopperChrome.client.registerCallback(CopperChrome.defaultHandler);
		
		// enable observing
		CopperChrome.observer = new CopperChrome.Observing();
		
		// handle auto discover
		CopperChrome.loadCachedResources();
		/*
		if (document.getElementById('toolbar_auto_discovery').checked) {
			CopperChrome.discover();
		}
		*/
		CopperChrome.updateResourceLinks();
		
		CopperChrome.loadDefaultPayload();
		
		// handle auto-request after redirect
		if (auto) {
			
			dump('INFO: Main.init [auto request after redirect]\n');
			
			switch (auto) {
				case 0:             break;
				case Copper.GET:    CopperChrome.sendGet(); break;
				case Copper.POST:   CopperChrome.sendPost(); break;
				case Copper.PUT:    CopperChrome.sendPut(); break;
				case Copper.DELETE: CopperChrome.sendDelete(); break;
				default: dump('WARNING: Main.init [unknown method for auto-request: '+auto+']\n');
			}
			
			// reset auto-request
			CopperChrome.prefManager.setIntPref('extensions.copper.auto-request.method', 0);
		}
		
	} catch( ex ) {
		CopperChrome.errorHandler({getCopperCode:function(){return ex;},getPayload:function(){return '';}});
		
	    dump('ERROR: Main.init ['+ex+']\n');
	}
};

CopperChrome.unload = function() {
	// shut down socket required for refresh (F5), client might be null for parseUri() redirects
	if (CopperChrome.client!=null) {
		CopperChrome.client.shutdown();
	}
	
	CopperChrome.saveBehavior();
	CopperChrome.savePayload();
	CopperChrome.saveDebugOptions();
};


// Settings callbacks
////////////////////////////////////////////////////////////////////////////////

CopperChrome.behaviorUpdate = function(target) {
	if (target.id=='menu_behavior_retransmissions') {
		CopperChrome.behavior.retransmissions = target.getAttribute('checked')=='true'; 
		CopperChrome.client.setRetransmissions(CopperChrome.behavior.retransmissions);
	} else if (target.id=='menu_behavior_show_unknown') {
		CopperChrome.behavior.showUnknown = target.getAttribute('checked')=='true';
	} else if (target.id=='menu_behavior_reject_unknown') {
		CopperChrome.behavior.rejectUnknown = target.getAttribute('checked')=='true';
	} else if (target.id.substr(0,24)=='menu_behavior_block_size') {
		CopperChrome.behavior.blockSize = target.value;
	} else if (target.id=='menu_behavior_token_observe') {
		CopperChrome.behavior.observeToken = target.getAttribute('checked')=='true';
	} else if (target.id.substr(0,21)=='menu_behavior_observe') {
		CopperChrome.behavior.observeCancellation = target.value;
	}
};


// Toolbar commands
////////////////////////////////////////////////////////////////////////////////

CopperChrome.sendGet = function(uri) {
	try {
		CopperChrome.client.cancelTransactions();
		
		uri = CopperChrome.checkUri(uri, Copper.GET);
		
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, Copper.GET, uri);
		
		CopperChrome.checkDebugOptions(message);
		
		CopperChrome.clearLabels();
		CopperChrome.client.send( message );
	} catch (ex) {
		alert('ERROR: Main.sendGet ['+ex+']');
	}
};
CopperChrome.sendBlockwiseGet = function(num, size, uri) {
	try {
		//CopperChrome.client.cancelTransactions();
	
		if (!num) num = 0;
		if (!size) size = CopperChrome.behavior.blockSize;
		uri = CopperChrome.checkUri(uri, Copper.GET);
		
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, Copper.GET, uri);
		
		CopperChrome.checkDebugOptions(message);
		
		// (re)set to useful block option
		message.setBlock(num, size);
		
		// token indicates a blockwise get for
		
		if (num=0) CopperChrome.clearLabels();
		CopperChrome.client.send( message, CopperChrome.blockwiseHandler );
	} catch (ex) {
		alert('ERROR: Main.sendBlockwiseGet ['+ex+']');
	}
};
CopperChrome.sendBlockwiseObserveGet = function(num, size, token) {
	try {
		//CopperChrome.client.cancelTransactions();
	
		if (!num) num = 0;
		if (!size) size = CopperChrome.behavior.blockSize;
		uri = CopperChrome.checkUri(null, Copper.GET);
		
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, Copper.GET, uri);
		
		message.setObserve(0);
		
		if (token) message.setToken(token);
		
		// (re)set to useful block option
		message.setBlock(num, size);
		
		// token indicates a blockwise get for
		
		if (num=0) CopperChrome.clearLabels();
		CopperChrome.client.send( message, CopperChrome.observingHandler );
	} catch (ex) {
		alert('ERROR: Main.sendBlockwiseObserveGet ['+ex+']');
	}
};

CopperChrome.sendPost = function(uri) {
	CopperChrome.client.cancelTransactions();
	CopperChrome.doUpload(Copper.POST, uri);
};

CopperChrome.sendPut = function(uri) {
	CopperChrome.client.cancelTransactions();
	CopperChrome.doUpload(Copper.PUT, uri);
};

CopperChrome.doUpload = function(method, uri) {
	try {
		
		uri = CopperChrome.checkUri(uri, method, document.getElementById('toolbar_payload_mode').value);
		
		let pl = '';
		
		if (document.getElementById('toolbar_payload_mode').value=='page') {
			pl = Copper.str2bytes(document.getElementById('payload_text_page').value);
		} else {
			if (!CopperChrome.payloadFileLoaded) {
				// file loading as async, wait until done
				window.setTimeout(function() {CopperChrome.doUpload(method,uri);}, 50);
				return;
			}
			pl = Copper.data2bytes(CopperChrome.payloadFileData);
		}
		
		// store payload in case server requests blockwise upload
		CopperChrome.uploadMethod = method; // POST or PUT
		CopperChrome.uploadBlocks = pl;
		
		// blockwise uploads
		if (document.getElementById('chk_debug_options').checked && document.getElementById('debug_option_block1').value!='' && pl.length > CopperChrome.behavior.blockSize) {
			
			CopperChrome.doBlockwiseUpload(parseInt(document.getElementById('debug_option_block1').value), CopperChrome.behavior.blockSize, uri);
			return;
		}
		
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, method, uri, pl);
		
		CopperChrome.checkDebugOptions(message);
		
		CopperChrome.clearLabels();
		CopperChrome.client.send( message );
	} catch (ex) {
		alert('ERROR: Main.doUpload ['+ex+']');
	}
}

CopperChrome.doBlockwiseUpload = function(num, size, uri) {

	let uri = CopperChrome.checkUri(uri, CopperChrome.uploadMethod);
	
	if (CopperChrome.uploadBlocks==null || CopperChrome.uploadMethod==0) {
		alert("WARNING: Main.doBlockwiseUpload [no upload in progress, cancelling]");
		return;
	}

	if ( (num>0) && (size*(num-1) > CopperChrome.uploadBlocks.length)) { // num-1, as we are called with the num to send, not was has been send
		alert('ERROR: Main.doBlockwiseUpload [debug Block1 out of payload scope]');
		return;
	}
	
	try {
		let more = false;
		
		if (CopperChrome.uploadBlocks.length > (num+1) * size) { // num+1, as we start counting at 0...
			more = true;
		}
		
		let pl = CopperChrome.uploadBlocks.slice(size*num, size*(num+1));
		
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, CopperChrome.uploadMethod, uri, pl);
		
		CopperChrome.checkDebugOptions(message);
		
		message.setBlock1(num, size, more);
		
		if (num==0) CopperChrome.clearLabels();
		CopperChrome.client.send( message, CopperChrome.blockwiseHandler );
	} catch (ex) {
		alert('ERROR: Main.doBlockwiseUpload ['+ex+']');
	}
};

CopperChrome.sendDelete = function(uri) {
	try {
		CopperChrome.client.cancelTransactions();
		
		uri = CopperChrome.checkUri(uri, Copper.DELETE);
		
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, Copper.DELETE, uri);
		
		CopperChrome.checkDebugOptions(message);
		
		CopperChrome.clearLabels();
		CopperChrome.client.send( message );
	} catch (ex) {
		alert('ERROR: Main.sendDelete ['+ex+']');
	}
};

CopperChrome.observe = function(uri) {
	try {
		//CopperChrome.client.cancelTransactions();
		
		uri = CopperChrome.checkUri(uri);

		CopperChrome.observer.subscribe(uri, CopperChrome.observingHandler);
		
	} catch (ex) {
		alert('ERROR: Main.observe ['+ex+']');
	}
};

CopperChrome.discover = function(block, size) {
	try {
		var message = new CopperChrome.CoapMessage(Copper.MSG_TYPE_CON, Copper.GET, Copper.WELL_KNOWN_RESOURCES);
		
		if (block!=null) {
			if (size==null) size = CopperChrome.behavior.blockSize;
			message.setBlock(block, size);
		} 
		
		CopperChrome.client.send( message, CopperChrome.discoverHandler );
	} catch (ex) {
		alert('ERROR: Main.discover ['+ex+']');
	}
};

// like discover, but resets cached resources -- used for the button
CopperChrome.reDiscover = function() {
	dump('INFO: resetting cached resources\n');
	CopperChrome.prefManager.setCharPref('extensions.copper.resources.'+CopperChrome.hostname+':'+CopperChrome.port, '' );
	CopperChrome.resources = new Object();
	
	CopperChrome.discover();
};
