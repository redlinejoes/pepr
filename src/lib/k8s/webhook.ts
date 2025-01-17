// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2023-Present The Pepr Authors

import {
  AdmissionregistrationV1Api,
  AdmissionregistrationV1WebhookClientConfig,
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  RbacAuthorizationV1Api,
  V1ClusterRole,
  V1ClusterRoleBinding,
  V1Deployment,
  V1LabelSelectorRequirement,
  V1MutatingWebhookConfiguration,
  V1Namespace,
  V1NetworkPolicy,
  V1Secret,
  V1Service,
  V1ServiceAccount,
  dumpYaml,
} from "@kubernetes/client-node";
import crypto from "crypto";
import { gzipSync } from "zlib";
import Log from "../logger";
import { ModuleConfig } from "../types";
import { TLSOut, genTLS } from "./tls";

const peprIgnore: V1LabelSelectorRequirement = {
  key: "pepr.dev",
  operator: "NotIn",
  values: ["ignore"],
};

export class Webhook {
  private name: string;
  private _tls: TLSOut;

  public image: string;

  public get tls(): TLSOut {
    return this._tls;
  }

  constructor(private readonly config: ModuleConfig, private readonly host?: string) {
    this.name = `pepr-${config.uuid}`;

    this.image = `ghcr.io/defenseunicorns/pepr/controller:v${config.version}`;

    // Generate the ephemeral tls things
    this._tls = genTLS(this.host || `${this.name}.pepr-system.svc`);
  }

  /** Generate the pepr-system namespace */
  namespace(): V1Namespace {
    return {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: { name: "pepr-system" },
    };
  }

  /**
   * Grants the controller access to cluster resources beyond the mutating webhook.
   *
   * @todo: should dynamically generate this based on resources used by the module. will also need to explore how this should work for multiple modules.
   * @returns
   */
  clusterRole(): V1ClusterRole {
    return {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name: this.name },
      rules: [
        {
          // @todo: make this configurable
          apiGroups: ["*"],
          resources: ["*"],
          verbs: ["create", "delete", "get", "list", "patch", "update", "watch"],
        },
      ],
    };
  }

  clusterRoleBinding(): V1ClusterRoleBinding {
    const name = this.name;
    return {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name },
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name,
      },
      subjects: [
        {
          kind: "ServiceAccount",
          name,
          namespace: "pepr-system",
        },
      ],
    };
  }

  serviceAccount(): V1ServiceAccount {
    return {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: this.name,
        namespace: "pepr-system",
      },
    };
  }

  tlsSecret(): V1Secret {
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: `${this.name}-tls`,
        namespace: "pepr-system",
      },
      type: "kubernetes.io/tls",
      data: {
        "tls.crt": this._tls.crt,
        "tls.key": this._tls.key,
      },
    };
  }

  mutatingWebhook(): V1MutatingWebhookConfiguration {
    const { name } = this;
    const ignore = [peprIgnore];

    // Add any namespaces to ignore
    if (this.config.alwaysIgnore.namespaces.length > 0) {
      ignore.push({
        key: "kubernetes.io/metadata.name",
        operator: "NotIn",
        values: this.config.alwaysIgnore.namespaces,
      });
    }

    const clientConfig: AdmissionregistrationV1WebhookClientConfig = {
      caBundle: this._tls.ca,
    };

    // If a host is specified, use that with a port of 3000
    if (this.host) {
      clientConfig.url = `https://${this.host}:3000/mutate`;
    } else {
      // Otherwise, use the service
      clientConfig.service = {
        name: this.name,
        namespace: "pepr-system",
        path: "/mutate",
      };
    }

    return {
      apiVersion: "admissionregistration.k8s.io/v1",
      kind: "MutatingWebhookConfiguration",
      metadata: { name },
      webhooks: [
        {
          name: `${name}.pepr.dev`,
          admissionReviewVersions: ["v1", "v1beta1"],
          clientConfig,
          failurePolicy: "Ignore",
          matchPolicy: "Equivalent",
          timeoutSeconds: 15,
          namespaceSelector: {
            matchExpressions: ignore,
          },
          objectSelector: {
            matchExpressions: ignore,
          },
          // @todo: make this configurable
          rules: [
            {
              apiGroups: ["*"],
              apiVersions: ["*"],
              operations: ["CREATE", "UPDATE", "DELETE"],
              resources: ["*/*"],
            },
          ],
          // @todo: track side effects state
          sideEffects: "None",
        },
      ],
    };
  }

  deployment(hash: string): V1Deployment {
    return {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: {
        name: this.name,
        namespace: "pepr-system",
        labels: {
          app: this.name,
        },
      },
      spec: {
        replicas: 2,
        selector: {
          matchLabels: {
            app: this.name,
          },
        },
        template: {
          metadata: {
            labels: {
              app: this.name,
            },
          },
          spec: {
            priorityClassName: "system-node-critical",
            serviceAccountName: this.name,
            containers: [
              {
                name: "server",
                image: this.image,
                imagePullPolicy: "IfNotPresent",
                command: ["node", "/app/node_modules/pepr/dist/run.js", hash, "-l", "debug"],
                livenessProbe: {
                  httpGet: {
                    path: "/healthz",
                    port: 3000,
                    scheme: "HTTPS",
                  },
                },
                ports: [
                  {
                    containerPort: 3000,
                  },
                ],
                resources: {
                  requests: {
                    memory: "64Mi",
                    cpu: "100m",
                  },
                  limits: {
                    memory: "256Mi",
                    cpu: "500m",
                  },
                },
                volumeMounts: [
                  {
                    name: "tls-certs",
                    mountPath: "/etc/certs",
                    readOnly: true,
                  },
                  {
                    name: "module",
                    mountPath: `/app/load`,
                    readOnly: true,
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "tls-certs",
                secret: {
                  secretName: `${this.name}-tls`,
                },
              },
              {
                name: "module",
                secret: {
                  secretName: `${this.name}-module`,
                },
              },
            ],
          },
        },
      },
    };
  }

  /** Only permit the kube-system ns ingress access to the controller */
  networkPolicy(): V1NetworkPolicy {
    return {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: {
        name: this.name,
        namespace: "pepr-system",
      },
      spec: {
        podSelector: {
          matchLabels: {
            app: this.name,
          },
        },
        policyTypes: ["Ingress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    "kubernetes.io/metadata.name": "kube-system",
                  },
                },
              },
            ],
            ports: [
              {
                protocol: "TCP",
                port: 443,
              },
            ],
          },
        ],
      },
    };
  }

  service(): V1Service {
    return {
      apiVersion: "v1",
      kind: "Service",
      metadata: {
        name: this.name,
        namespace: "pepr-system",
      },
      spec: {
        selector: {
          app: this.name,
        },
        ports: [
          {
            port: 443,
            targetPort: 3000,
          },
        ],
      },
    };
  }

  moduleSecret(data: Buffer, hash: string): V1Secret {
    // Compress the data
    const compressed = gzipSync(data);
    const path = `module-${hash}.js.gz`;
    return {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name: `${this.name}-module`,
        namespace: "pepr-system",
      },
      type: "Opaque",
      data: {
        [path]: compressed.toString("base64"),
      },
    };
  }

  zarfYaml(path: string) {
    const zarfCfg = {
      kind: "ZarfPackageConfig",
      metadata: {
        name: this.name,
        description: `Pepr Module: ${this.config.description}`,
        url: "https://github.com/defenseunicorns/pepr",
      },
      components: [
        {
          name: "module",
          required: true,
          manifests: [
            {
              name: "module",
              namespace: "pepr-system",
              files: [path],
            },
          ],
          images: [this.image],
        },
      ],
    };

    return dumpYaml(zarfCfg, { noRefs: true });
  }

  allYaml(code: Buffer) {
    // Generate a hash of the code
    const hash = crypto.createHash("sha256").update(code).digest("hex");

    const resources = [
      this.namespace(),
      this.networkPolicy(),
      this.clusterRole(),
      this.clusterRoleBinding(),
      this.serviceAccount(),
      this.tlsSecret(),
      this.mutatingWebhook(),
      this.deployment(hash),
      this.service(),
      this.moduleSecret(code, hash),
    ];

    // Convert the resources to a single YAML string
    return resources.map(r => dumpYaml(r, { noRefs: true })).join("---\n");
  }

  async deploy(code: Buffer) {
    Log.info("Establishing connection to Kubernetes");

    const namespace = "pepr-system";
    const hash = crypto.createHash("sha256").update(code).digest("hex");

    // Deploy the resources using the k8s API
    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromDefault();

    const coreV1Api = kubeConfig.makeApiClient(CoreV1Api);
    const rbacApi = kubeConfig.makeApiClient(RbacAuthorizationV1Api);
    const appsApi = kubeConfig.makeApiClient(AppsV1Api);
    const admissionApi = kubeConfig.makeApiClient(AdmissionregistrationV1Api);
    const networkApi = kubeConfig.makeApiClient(NetworkingV1Api);

    const ns = this.namespace();
    try {
      Log.info("Checking for namespace");
      await coreV1Api.readNamespace(namespace);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Creating namespace");
      await coreV1Api.createNamespace(ns);
    }

    const wh = this.mutatingWebhook();
    try {
      Log.info("Creating mutating webhook");
      await admissionApi.createMutatingWebhookConfiguration(wh);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating mutating webhook");
      await admissionApi.deleteMutatingWebhookConfiguration(wh.metadata.name);
      await admissionApi.createMutatingWebhookConfiguration(wh);
    }

    // If a host is specified, we don't need to deploy the rest of the resources
    if (this.host) {
      return;
    }

    const netpol = this.networkPolicy();
    try {
      Log.info("Checking for network policy");
      await networkApi.readNamespacedNetworkPolicy(netpol.metadata.name, namespace);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Creating network policy");
      await networkApi.createNamespacedNetworkPolicy(namespace, netpol);
    }

    const crb = this.clusterRoleBinding();
    try {
      Log.info("Creating cluster role binding");
      await rbacApi.createClusterRoleBinding(crb);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating cluster role binding");
      await rbacApi.deleteClusterRoleBinding(crb.metadata.name);
      await rbacApi.createClusterRoleBinding(crb);
    }

    const cr = this.clusterRole();
    try {
      Log.info("Creating cluster role");
      await rbacApi.createClusterRole(cr);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating  the cluster role");
      try {
        await rbacApi.deleteClusterRole(cr.metadata.name);
        await rbacApi.createClusterRole(cr);
      } catch (e) {
        Log.debug(e.body);
      }
    }

    const sa = this.serviceAccount();
    try {
      Log.info("Creating service account");
      await coreV1Api.createNamespacedServiceAccount(namespace, sa);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating service account");
      await coreV1Api.deleteNamespacedServiceAccount(sa.metadata.name, namespace);
      await coreV1Api.createNamespacedServiceAccount(namespace, sa);
    }

    const mod = this.moduleSecret(code, hash);
    try {
      Log.info("Creating module secret");
      await coreV1Api.createNamespacedSecret(namespace, mod);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating module secret");
      await coreV1Api.deleteNamespacedSecret(mod.metadata.name, namespace);
      await coreV1Api.createNamespacedSecret(namespace, mod);
    }

    const svc = this.service();
    try {
      Log.info("Creating service");
      await coreV1Api.createNamespacedService(namespace, svc);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating service");
      await coreV1Api.deleteNamespacedService(svc.metadata.name, namespace);
      await coreV1Api.createNamespacedService(namespace, svc);
    }

    const tls = this.tlsSecret();
    try {
      Log.info("Creating TLS secret");
      await coreV1Api.createNamespacedSecret(namespace, tls);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating TLS secret");
      await coreV1Api.deleteNamespacedSecret(tls.metadata.name, namespace);
      await coreV1Api.createNamespacedSecret(namespace, tls);
    }

    const dep = this.deployment(hash);
    try {
      Log.info("Creating deployment");
      await appsApi.createNamespacedDeployment(namespace, dep);
    } catch (e) {
      Log.debug(e.body);
      Log.info("Removing and re-creating deployment");
      await appsApi.deleteNamespacedDeployment(dep.metadata.name, namespace);
      await appsApi.createNamespacedDeployment(namespace, dep);
    }
  }
}
