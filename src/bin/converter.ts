/**
 * Quick & dirty converter between the 'old' FLL Overlay Suite server events, and the new
 * mserver messages.
 */

"use strict";

import util = require("util");
import uuid = require("node-uuid");
import fs = require("fs");
import path = require("path");
import overlay = require("../lib/overlay");
import mhub = require("mhub");

import MClient = mhub.MClient;
import Message = mhub.Message;

var configFile = path.resolve(__dirname, "../../converter.conf.json");
console.log("Using config file " + configFile);
var config = JSON.parse(fs.readFileSync(configFile, "utf8"));

/* Shared state */

var currentInstance = "proxy-" + uuid.v1();
var controlConn: overlay.OverlayClient = null;
var mclient: MClient = null;

/* FLL Overlay Server -> MServer conversion */

function stringToMessage(data: string): Message {
	function boolToShowHide(s: string): string {
		return (s === "True") ? "show" : "hide";
	};
	var s = new overlay.Splitter(data);
	var src = s.getPart();
	var cmd = s.getPart().toLowerCase();
	var msg: Message;
	var msgCmd: string;
	var msgData: { [name: string]: any } = {};
	switch (cmd) {
		case "servertime":
			var serverTime = s.getRest().split(":");
			var d = new Date();
			d.setHours(parseInt(serverTime[0], 10), parseInt(serverTime[1], 10), parseInt(serverTime[2], 10));
			msg = new Message("time:tick", {
				timestamp: d.toISOString()
			});
			break;
		case "showclock":
			msgCmd = s.getRest();
			if (msgCmd === "arm" || msgCmd === "start") {
				msgData["countdown"] = 150; // 2:30
			}
			msgData["timestamp"] = new Date().toISOString();
			msg = new Message("clock:" + msgCmd, msgData);
			break;
		case "showscores":
			msgCmd = s.getPart();
			if (msgCmd === "show") {
				msgData["type"] = s.getRest(); // qualifying etc.
			} else {
				msgData["when"] = (msgCmd === "hidelater") ? "end" : "now";
				msgCmd = "hide";
			};
			msg = new Message("scores:" + msgCmd, msgData);
			break;
		case "showimage":
			var imageName = s.getRest();
			if (imageName) {
				msgData["name"] = imageName;
				msgCmd = "show";
			} else {
				msgCmd = "hide";
			}
			msg = new Message("image:" + msgCmd, (msgCmd === "show") ? msgData : undefined);
			break;
		case "showtwitter":
		case "showtime":
			msg = new Message(cmd.substr(4) + ":" + boolToShowHide(s.getRest()));
			break;
		case "debugmessage":
			msg = new Message("debug:message", s.getRest());
			break;
		case "showmessage":
			msgCmd = (s.getPart() === "True") ? "hide" : "show"; // hideNow argument
			if (msgCmd === "show") {
				msgData["main"] = s.getRest(); // Note: don't use overlayMsgDecode() here
				msg = new Message("announcement:show", msgData);
			} else {
				msg = new Message("announcement:hide");
			}
			break;
		default:
			msgData["command"] = cmd;
			msgData["args"] = s.getRest();
			msg = new Message("misc:unknown_command", msgData);
			break;
	}
	msg.headers["x-overlay-source"] = src;
	return msg;
}

function overlay2mserver(): void {
	function log(msg: string): void { util.log("Overlay2MServer: " + msg); }
	var overlayConn: overlay.OverlayClient = null;
	var timer: any = null;
	function connect(): void {
		log("Connecting to overlay...");
		var overlayConn = new overlay.OverlayClient(config.overlay);
		overlayConn
			.on("ready", (): void => {
				log("Overlay connected");
				overlayConn.sendAndExpect("setsource " + currentInstance, 200);
				overlayConn.eventsMode();
			})
			.on("close", handleError)
			.on("error", handleError)
			.on("event", (data: string): void => {
				var msg = stringToMessage(data);
				// Skip 'noisy' events
				switch (msg.topic) {
					case "time:tick":
					case "debug:message":
					case "misc:unknown_command":
						return;
				}
				// Prevent message loops: don't forward stuff that we initiated ourselves
				if (msg.headers["x-overlay-source"] === currentInstance) {
					return;
				}
				msg.headers["x-via-" + currentInstance] = "true";
				log(util.inspect(msg));
				publish(msg);
			});
	}
	function handleError(e?: Error): void {
		if (e) {
			log("Overlay connection error '" + e.message + "', reconnecting...");
		} else {
			log("Overlay connection closed, reconnecting...");
		}
		if (overlayConn) {
			overlayConn.destroy();
		}
		if (controlConn) {
			log("Destroying control");
			// Also destroy control connection (which is not managed by us),
			// otherwise it will stay connected and will only notice its disconnect
			// when the first command is sent after that.
			controlConn.destroy();
		}
		overlayConn = null;
		clearTimeout(timer);
		timer = setTimeout(connect, 1000);
	}
	connect();
}

/* MServer -> FLL Overlay Server */

function messageToString(msg: Message): string {
	var p = msg.topic.split(":");
	var namespace = p[0];
	var cmd = p[1];
	switch (namespace) {
		case "clock":
			if (cmd === "arm" || cmd === "start" || cmd === "stop") {
				return cmd + "clock";
			}
			break;
		case "time":
		case "twitter":
			if (cmd === "show" || cmd === "hide") {
				return cmd + namespace;
			}
			break;
		case "announcement":
			if (cmd === "show" && typeof msg.data === "object" && typeof msg.data.main === "string") {
				return "directmsg " + overlay.messageEncode(msg.data.main);
			}
			break;
		case "image":
			if (cmd === "show" && msg.data && msg.data.name) {
				return cmd + namespace + " " + msg.data.name;
			} else {
				return cmd + namespace;
			}
	}
	return null;
}

function mserver2overlay(): void {
	function log(msg: string): void { util.log("MServer2Overlay: " + msg); }

	var overlayConn: overlay.OverlayClient = null;
	var timer: any = null;
	function connect(): void {
		log("Connecting to overlay...");
		overlayConn = new overlay.OverlayClient(config.overlay);
		overlayConn
			.on("close", handleError)
			.on("error", handleError)
			.on("ready", (): void => {
				log("Overlay ready");
				overlayConn.sendAndExpect("setsource " + currentInstance, 200, (): void => {
					controlConn = overlayConn;
				});
			});
	}
	function handleError(e?: Error): void {
		controlConn = null;
		if (e) {
			log("Overlay connection error '" + e.message + "', reconnecting...");
		} else {
			log("Overlay connection closed, reconnecting...");
		}
		if (overlayConn) {
			overlayConn.destroy();
		}
		overlayConn = null;
		clearTimeout(timer);
		timer = setTimeout(connect, 1000);
	}
	connect();
}

function mserverConnecter(): void {
	function connect(): void {
		var c = new MClient(config.mserver.url);
		c.on("open", (): void => {
			console.log("MClient connected");
			mclient = c;
			c.subscribe(config.mserver.subscribe_node);
		});
		c.on("close", (): void => {
			console.log("MClient closed");
			mclient = null;
			setTimeout((): void => {
				connect();
			}, 1000);
		});
		c.on("error", (e: Error): void => {
			console.log("MClient error:", e);
			mclient = null;
			setTimeout((): void => {
				connect();
			}, 10000);
		});
		c.on("message", (m: Message): void => {
			handleMessage(m);
		});
	}
	connect();
}

function publish(message: Message): Promise<void> {
	if (!mclient) {
		return Promise.reject(new Error("not connected"));
	}
	return mclient.publish(config.mserver.publish_node, message);
}

function handleMessage(message: Message): void {
	if (message.headers["x-via-" + currentInstance]) {
		return; // Skip the messages we posted ourselves
	}
	var s = messageToString(message);
	if (s) {
		console.log("->" + s);
		if (controlConn) {
			controlConn.sendAndExpect(s, 200, null, (e: Error): void => {
				console.log("Error sending '" + s + "', server said:", e);
			});
		}
	}
}

/* Start (endless) conversions */

mserverConnecter();
overlay2mserver();
mserver2overlay();
