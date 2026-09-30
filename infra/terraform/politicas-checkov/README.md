# Políticas propias de Checkov

Checkov no trae controles para el provider `kreuzwerker/docker`: sobre
`main.tf` no evalúa ningún recurso (`resource_count: 0`) y el job `iac-scan`
pasaba sin revisar nada. Estas políticas escriben en código lo que la
arquitectura promete, para que un cambio que lo rompa haga fallar el
pipeline:

| Política | Qué exige |
|---|---|
| `CKV2_LM_1` | La red de la base (`*db*`) es interna: sin salida a Internet ni acceso desde el host |
| `CKV2_LM_2` | Ningún contenedor publica puertos fuera de `127.0.0.1` |
| `CKV2_LM_3` | La base de datos no publica ningún puerto |
| `CKV2_LM_4` | Cada contenedor tiene el sistema de archivos de solo lectura |
| `CKV2_LM_5` | Cada contenedor corre con `no-new-privileges` |
| `CKV2_LM_6` | Ningún contenedor corre en modo privilegiado |

Localmente:

```bash
docker run --rm -v "$PWD/infra/terraform:/tf:ro" bridgecrew/checkov \
  -d /tf --framework terraform --external-checks-dir /tf/politicas-checkov --compact
```
