// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2023-Present The Pepr Authors

// setup package generates the boilerplate for a new capability or set of capabilities.
package setup

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

func writeSDK(base string) error {
	if sdkFiles == nil {
		return ErrMissingSDKFiles
	}

	// Walk the directory tree and copy the files to the output directory.
	return fs.WalkDir(sdkFiles, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// Change sdk -> .sdk for all paths
		orgPath := path
		if path != "." {
			path = fmt.Sprintf(".%s", path)
		}

		if d.IsDir() {
			// Create a corresponding directory in the output directory.
			outputSubdir := filepath.Join(base, path)
			return os.MkdirAll(outputSubdir, 0755)
		}

		// Read the file contents from the embedded filesystem.
		fileContents, err := sdkFiles.ReadFile(orgPath)
		if err != nil {
			return err
		}

		// Write the file to the output directory.
		outputPath := filepath.Join(base, path)
		return os.WriteFile(outputPath, fileContents, 0644)
	})
}