require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Consumed as a local :path pod by the generated ios/ project (cap sync writes
# the Podfile entry). ZIPFoundation is the unzip mechanism: per-entry random
# access plus streaming extraction, which is what keeps archive bytes out of
# the webview entirely.
Pod::Spec.new do |s|
  s.name = 'OrZip'
  s.version = package['version']
  s.summary = package['description']
  s.license = package['license']
  s.homepage = 'https://github.com/smelvintime/Offline-Reader'
  s.author = package['author']
  s.source = { :git => 'https://github.com/smelvintime/Offline-Reader.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  s.ios.deployment_target = '15.0'
  s.dependency 'Capacitor'
  s.dependency 'ZIPFoundation', '~> 0.9.19'
  s.swift_version = '5.1'
end
