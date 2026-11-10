{
  description = "moshimoshimonshin local development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # nixpkgs の Flutter が対応するプラットフォームに合わせる。
      # x86_64-darwin は nixpkgs の Flutter が未対応のため含めない。
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          firebaseCli = pkgs.writeShellScriptBin "firebase" ''
            exec ${pkgs.nodejs_22}/bin/npx --yes firebase-tools@15.35.0 "$@"
          '';
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              flutter
              nodejs_22
              firebaseCli
              google-cloud-sdk
              docker-client
              docker-compose
              gnumake
              git
            ];

            shellHook = ''
              echo "moshimoshimonshin devShell"
              echo "Docker デーモンはこの shell では起動しません。'make up' の前に起動してください。"
              echo "確認: make doctor"
            '';
          };
        }
        // nixpkgs.lib.optionalAttrs (system == "x86_64-linux") {
          browser-integration = pkgs.mkShell {
            packages = with pkgs; [
              flutter
              nodejs_22
              firebaseCli
              jdk21
              python3
              firefox
              xvfb
            ];

            shellHook = ''
              echo "moshimoshimonshin browser integration devShell"
              echo "firebase wrapper is pinned to firebase-tools@15.35.0 (same as CI)"
            '';
          };
        }
      );
    };
}
