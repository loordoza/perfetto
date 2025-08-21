// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {RecordProbe, RecordSubpage} from '../config/config_interfaces';
import {TraceConfigBuilder} from '../config/trace_config_builder';
import {Toggle} from './widgets/toggle';

export function networkRecordSection(): RecordSubpage {
  return {
    kind: 'PROBES_PAGE',
    id: 'network',
    title: 'Network',
    subtitle: 'Network activity, Wi-Fi events',
    icon: 'wifi',
    probes: [wifiNetworkTracing()],
  };
}

function wifiNetworkTracing(): RecordProbe {
  const cfgMacEvents = [
    'cfg80211/*',
    'mac80211/*',
  ];
  const netEvents = [
    'net/netif_receive_skb',
    'net/net_dev_xmit',
    'net/napi_gro_receive_entry',
    'net/napi_gro_receive_exit',
  ];
  const settings = {
    cfg_mac: new Toggle({
      title: 'Core events',
      cssClass: '.thin',
      default: true,
      descr: 'Includes configuration (cfg80211) and low-level MAC events (mac80211).',
    }),
    net: new Toggle({
      title: 'Packet traffic',
      cssClass: '.thin',
      default: false,
      descr: 'Traces packet handling within the kernel, including transmit and receive events.',
    }),
  }
  return {
    id: 'wifi_network_tracing',
    image: 'rec_wifi.png',
    title: 'Wi-Fi ftrace events',
    supportedPlatforms: ['LINUX', 'CHROME_OS'],
    description:
      'Enables tracing of crucial kernel events related to Wi-Fi operation',
    settings,
    genConfig: function (tc: TraceConfigBuilder) {
      if (settings.cfg_mac.enabled) {
        tc.addFtraceEvents(...cfgMacEvents);
      }
      if (settings.net.enabled) {
        const bufId = 'ftrace_net';
        const bufSizeKb = 1024;
        tc.addBuffer(bufId, bufSizeKb);
        const cfg = tc.addDataSource("linux.ftrace", bufId);
        cfg.ftraceConfig ??= {};
        cfg.ftraceConfig.ftraceEvents ??= [];
        cfg.ftraceConfig.ftraceEvents.push(...netEvents);
      }
    },
  };
}
