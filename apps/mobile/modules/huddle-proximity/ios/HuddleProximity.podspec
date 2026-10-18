Pod::Spec.new do |s|
  s.name           = 'HuddleProximity'
  s.version        = '1.0.0'
  s.summary        = 'Rotating-ID Bluetooth proximity for Huddle'
  s.description    = 'Advertises and scans for rotating Bluetooth IDs so phones in a group can note when they were near each other.'
  s.author         = 'Anusha Chandra'
  s.homepage       = 'https://github.com/a77chand/huddle'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreBluetooth'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
