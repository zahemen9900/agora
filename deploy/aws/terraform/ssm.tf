resource "aws_ssm_document" "deploy" {
  name            = "agora-deploy"
  document_type   = "Command"
  document_format = "JSON"

  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Deploy an immutable Agora release by commit SHA"
    parameters = {
      ReleaseSha = {
        type           = "String"
        description    = "40-character lowercase Git commit SHA"
        allowedPattern = "^[0-9a-f]{40}$"
      }
    }
    mainSteps = [
      {
        action = "aws:runShellScript"
        name   = "deployRelease"
        inputs = {
          runCommand = ["/opt/agora/bin/deploy.sh {{ReleaseSha}}"]
        }
      }
    ]
  })
}
